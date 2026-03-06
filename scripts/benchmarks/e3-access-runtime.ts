#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema, SchemaGetter } from "effect";
import { planAccessExecution } from "../../libs/foundation/core/src/access-planner-runtime.ts";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import { makeInMemoryCaptureBundleStore } from "../../libs/foundation/core/src/capture-store-runtime.ts";
import { captureHttpArtifacts } from "../../libs/foundation/core/src/http-access-runtime.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";

const DEFAULT_SAMPLE_SIZE = 12;
const DEFAULT_WARMUP_ITERATIONS = 3;
const FIXED_DATE = "2026-03-06T10:30:00.000Z";

const PositiveIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);
const PositiveIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(PositiveIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);

const PERFORMANCE_BUDGETS = {
  baselineAccessP95Ms: 25,
  candidateAccessP95Ms: 50,
  retryRecoveryP95Ms: 300,
} as const;

const BenchmarkSummarySchema = Schema.Struct({
  samples: Schema.Int.check(Schema.isGreaterThan(0)),
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

const BenchmarkArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e3-access-runtime"),
  generatedAt: Schema.String,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  sampleSize: Schema.Int.check(Schema.isGreaterThan(0)),
  warmupIterations: Schema.Int.check(Schema.isGreaterThan(0)),
  budgets: Schema.Struct({
    baselineAccessP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
    candidateAccessP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
    retryRecoveryP95Ms: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  measurements: Schema.Struct({
    baselineAccess: BenchmarkSummarySchema,
    candidateAccess: BenchmarkSummarySchema,
    retryRecovery: BenchmarkSummarySchema,
  }),
  comparison: Schema.Struct({
    baselinePath: Schema.NullOr(Schema.String),
    deltas: Schema.Struct({
      baselineAccessP95Ms: Schema.NullOr(Schema.Finite),
      candidateAccessP95Ms: Schema.NullOr(Schema.Finite),
      retryRecoveryP95Ms: Schema.NullOr(Schema.Finite),
    }),
  }),
  status: Schema.Literals(["pass", "fail"] as const),
});

function decodePositiveIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
}

function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let baselinePath: string | undefined;
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--artifact") {
      artifactPath = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--baseline") {
      baselinePath = args[index + 1];
      index += 1;
      continue;
    }

    if (argument === "--sample-size") {
      sampleSize = decodePositiveIntegerOption(args[index + 1], DEFAULT_SAMPLE_SIZE);
      index += 1;
      continue;
    }

    if (argument === "--warmup") {
      warmupIterations = decodePositiveIntegerOption(args[index + 1], DEFAULT_WARMUP_ITERATIONS);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    ...(artifactPath !== undefined ? { artifactPath: resolve(artifactPath) } : {}),
    ...(baselinePath !== undefined ? { baselinePath: resolve(baselinePath) } : {}),
    sampleSize,
    warmupIterations,
  };
}

function percentile95(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

function roundToThree(value: number) {
  return Number.parseFloat(value.toFixed(3));
}

function summarizeMeasurements(values: readonly number[]) {
  return Schema.decodeUnknownSync(BenchmarkSummarySchema)({
    samples: values.length,
    minMs: roundToThree(Math.min(...values)),
    meanMs: roundToThree(values.reduce((total, value) => total + value, 0) / values.length),
    p95Ms: roundToThree(percentile95(values)),
    maxMs: roundToThree(Math.max(...values)),
  });
}

async function measureEffect(
  sampleSize: number,
  warmupIterations: number,
  effectFactory: () => Effect.Effect<unknown, unknown, never>,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await Effect.runPromise(effectFactory());
  }

  const values: number[] = [];
  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    await Effect.runPromise(effectFactory());
    values.push(performance.now() - startedAt);
  }

  return summarizeMeasurements(values);
}

async function readBaseline(path: string | undefined) {
  if (path === undefined) {
    return undefined;
  }

  const baseline = await readFile(path, "utf8");
  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)(JSON.parse(baseline));
}

function makeFixtures() {
  const target = Schema.decodeUnknownSync(TargetProfileSchema)({
    id: "target-product-001",
    tenantId: "tenant-main",
    domain: "example.com",
    kind: "productPage",
    canonicalKey: "catalog/product-001",
    seedUrls: ["https://example.com/products/001"],
    accessPolicyId: "policy-http",
    packId: "pack-example-com",
    priority: 10,
  });
  const pack = Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-example-com",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: "policy-http",
    version: "2026.03.06",
  });
  const accessPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
    id: "policy-http",
    mode: "http",
    perDomainConcurrency: 8,
    globalConcurrency: 64,
    timeoutMs: 1_000,
    maxRetries: 2,
    render: "never",
  });

  return { target, pack, accessPolicy };
}

function successResponse() {
  return new Response("<html><body><h1>Example Product</h1></body></html>", {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-request-id": "req-001",
    },
  });
}

function makePlan() {
  const fixtures = makeFixtures();

  return planAccessExecution({
    ...fixtures,
    createdAt: FIXED_DATE,
  }).pipe(Effect.map(({ plan }) => plan));
}

function runBaselineAccess() {
  return Effect.gen(function* () {
    const plan = yield* makePlan();
    const response = yield* Effect.tryPromise(() => Promise.resolve(successResponse()));
    const body = yield* Effect.tryPromise(() => response.text());

    return { runId: plan.id, bodyLength: body.length };
  });
}

function runCandidateAccess() {
  return Effect.gen(function* () {
    const plan = yield* makePlan();
    const bundle = yield* captureHttpArtifacts(
      plan,
      async () => Promise.resolve(successResponse()),
      () => new Date(FIXED_DATE),
      undefined,
      () => Effect.void,
    );
    const store = yield* makeInMemoryCaptureBundleStore();
    const stored = yield* store.persistBundle(plan.id, bundle);

    return stored.bundle.artifacts.length;
  });
}

function runRetryRecovery() {
  return Effect.gen(function* () {
    const plan = yield* makePlan();
    let attempts = 0;
    const bundle = yield* captureHttpArtifacts(
      plan,
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("transient upstream"));
        }

        return Promise.resolve(successResponse());
      },
      () => new Date(FIXED_DATE),
      undefined,
      () => Effect.void,
    );
    const store = yield* makeInMemoryCaptureBundleStore();
    yield* store.persistBundle(plan.id, bundle);

    return attempts;
  });
}

function buildArtifact(
  options: ReturnType<typeof parseOptions>,
  measurements: {
    readonly baselineAccess: Schema.Schema.Type<typeof BenchmarkSummarySchema>;
    readonly candidateAccess: Schema.Schema.Type<typeof BenchmarkSummarySchema>;
    readonly retryRecovery: Schema.Schema.Type<typeof BenchmarkSummarySchema>;
  },
  baseline: Schema.Schema.Type<typeof BenchmarkArtifactSchema> | undefined,
) {
  const status =
    measurements.baselineAccess.p95Ms <= PERFORMANCE_BUDGETS.baselineAccessP95Ms &&
    measurements.candidateAccess.p95Ms <= PERFORMANCE_BUDGETS.candidateAccessP95Ms &&
    measurements.retryRecovery.p95Ms <= PERFORMANCE_BUDGETS.retryRecoveryP95Ms
      ? "pass"
      : "fail";

  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)({
    benchmark: "e3-access-runtime",
    generatedAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    sampleSize: options.sampleSize,
    warmupIterations: options.warmupIterations,
    budgets: PERFORMANCE_BUDGETS,
    measurements,
    comparison: {
      baselinePath: options.baselinePath ?? null,
      deltas: {
        baselineAccessP95Ms: baseline
          ? roundToThree(
              measurements.baselineAccess.p95Ms - baseline.measurements.baselineAccess.p95Ms,
            )
          : null,
        candidateAccessP95Ms: baseline
          ? roundToThree(
              measurements.candidateAccess.p95Ms - baseline.measurements.candidateAccess.p95Ms,
            )
          : null,
        retryRecoveryP95Ms: baseline
          ? roundToThree(
              measurements.retryRecovery.p95Ms - baseline.measurements.retryRecovery.p95Ms,
            )
          : null,
      },
    },
    status,
  });
}

async function writeArtifact(path: string | undefined, artifact: unknown) {
  if (path === undefined) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseOptions(Bun.argv.slice(2));
  const baseline = await readBaseline(options.baselinePath);
  const measurements = {
    baselineAccess: await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      runBaselineAccess,
    ),
    candidateAccess: await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      runCandidateAccess,
    ),
    retryRecovery: await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      runRetryRecovery,
    ),
  };
  const artifact = buildArtifact(options, measurements, baseline);

  await writeArtifact(options.artifactPath, artifact);
  console.log(JSON.stringify(artifact, null, 2));

  if (artifact.status !== "pass") {
    process.exitCode = 1;
  }
}

await main();
