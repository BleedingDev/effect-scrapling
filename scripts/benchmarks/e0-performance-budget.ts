#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect } from "effect";
import { createEngine, type FetchClient } from "effect-scrapling/sdk";

const DEFAULT_SAMPLE_SIZE = 12;
const DEFAULT_WARMUP_ITERATIONS = 3;

const PERFORMANCE_BUDGETS = {
  accessPreviewP95Ms: 50,
  extractRunP95Ms: 50,
  runDoctorP95Ms: 10,
  heapDeltaKiB: 16_384,
} as const;

type BenchmarkSummary = {
  readonly samples: number;
  readonly minMs: number;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

type BenchmarkArtifact = {
  readonly benchmark: "e0-performance-budget";
  readonly generatedAt: string;
  readonly environment: {
    readonly bun: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  readonly sampleSize: number;
  readonly warmupIterations: number;
  readonly budgets: typeof PERFORMANCE_BUDGETS;
  readonly measurements: {
    readonly accessPreview: BenchmarkSummary;
    readonly extractRun: BenchmarkSummary;
    readonly runDoctor: BenchmarkSummary;
    readonly heapDeltaKiB: number;
  };
  readonly comparison: {
    readonly baselinePath: string | null;
    readonly deltas: {
      readonly accessPreviewP95Ms: number | null;
      readonly extractRunP95Ms: number | null;
      readonly runDoctorP95Ms: number | null;
      readonly heapDeltaKiB: number | null;
    };
  };
  readonly status: "pass" | "fail";
};

type ParsedOptions = {
  readonly artifactPath?: string;
  readonly baselinePath?: string;
  readonly sampleSize: number;
  readonly warmupIterations: number;
};

const htmlFixture = `
  <html>
    <body>
      <main>
        <article>
          <h1>Effect Scrapling</h1>
          <p>Performance budget fixture</p>
        </article>
      </main>
    </body>
  </html>
`;

const mockFetch: FetchClient = async (input) => {
  const response = new Response(htmlFixture, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  Object.defineProperty(response, "url", {
    value: new Request(input).url,
    configurable: true,
  });

  return response;
};

function parseIntegerOption(rawValue: string | undefined, fallback: number): number {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${rawValue}"`);
  }

  return parsed;
}

function parseOptions(args: readonly string[]): ParsedOptions {
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
      sampleSize = parseIntegerOption(args[index + 1], DEFAULT_SAMPLE_SIZE);
      index += 1;
      continue;
    }

    if (argument === "--warmup") {
      warmupIterations = parseIntegerOption(args[index + 1], DEFAULT_WARMUP_ITERATIONS);
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

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)] ?? 0;
}

function roundToThree(value: number): number {
  return Number.parseFloat(value.toFixed(3));
}

function summarizeMeasurements(values: readonly number[]): BenchmarkSummary {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;

  return {
    samples: values.length,
    minMs: roundToThree(min),
    meanMs: roundToThree(mean),
    p95Ms: roundToThree(percentile95(values)),
    maxMs: roundToThree(max),
  };
}

async function measureEffect(
  sampleSize: number,
  warmupIterations: number,
  effectFactory: () => Effect.Effect<unknown, never, never>,
): Promise<BenchmarkSummary> {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await Effect.runPromise(effectFactory());
  }

  const samples: number[] = [];
  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    await Effect.runPromise(effectFactory());
    samples.push(performance.now() - startedAt);
  }

  return summarizeMeasurements(samples);
}

async function readBaseline(path: string | undefined): Promise<BenchmarkArtifact | undefined> {
  if (!path) {
    return undefined;
  }

  const baseline = await readFile(path, "utf8");
  return JSON.parse(baseline) as BenchmarkArtifact;
}

function buildArtifact(
  options: ParsedOptions,
  measurements: BenchmarkArtifact["measurements"],
  baseline: BenchmarkArtifact | undefined,
): BenchmarkArtifact {
  const status =
    measurements.accessPreview.p95Ms <= PERFORMANCE_BUDGETS.accessPreviewP95Ms &&
    measurements.extractRun.p95Ms <= PERFORMANCE_BUDGETS.extractRunP95Ms &&
    measurements.runDoctor.p95Ms <= PERFORMANCE_BUDGETS.runDoctorP95Ms &&
    measurements.heapDeltaKiB <= PERFORMANCE_BUDGETS.heapDeltaKiB
      ? "pass"
      : "fail";

  return {
    benchmark: "e0-performance-budget",
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
        accessPreviewP95Ms: baseline
          ? roundToThree(
              measurements.accessPreview.p95Ms - baseline.measurements.accessPreview.p95Ms,
            )
          : null,
        extractRunP95Ms: baseline
          ? roundToThree(measurements.extractRun.p95Ms - baseline.measurements.extractRun.p95Ms)
          : null,
        runDoctorP95Ms: baseline
          ? roundToThree(measurements.runDoctor.p95Ms - baseline.measurements.runDoctor.p95Ms)
          : null,
        heapDeltaKiB: baseline
          ? roundToThree(measurements.heapDeltaKiB - baseline.measurements.heapDeltaKiB)
          : null,
      },
    },
    status,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const heapStart = process.memoryUsage().heapUsed;
  const engine = await Effect.runPromise(
    createEngine({
      fetchClient: mockFetch,
    }),
  );

  try {
    const accessPreviewMetrics = await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      () =>
        engine
          .accessPreview({
            url: "https://bench.example/preview",
          })
          .pipe(Effect.orDie),
    );

    const extractRunMetrics = await measureEffect(
      options.sampleSize,
      options.warmupIterations,
      () =>
        engine
          .extractRun({
            url: "https://bench.example/extract",
            selector: "h1",
          })
          .pipe(Effect.orDie),
    );

    const runDoctorMetrics = await measureEffect(options.sampleSize, options.warmupIterations, () =>
      engine.runDoctor().pipe(Effect.orDie),
    );

    const heapEnd = process.memoryUsage().heapUsed;
    const heapDeltaKiB = roundToThree(Math.max(0, heapEnd - heapStart) / 1024);
    const baseline = await readBaseline(options.baselinePath);
    const artifact = buildArtifact(
      options,
      {
        accessPreview: accessPreviewMetrics,
        extractRun: extractRunMetrics,
        runDoctor: runDoctorMetrics,
        heapDeltaKiB,
      },
      baseline,
    );

    if (options.artifactPath) {
      await mkdir(dirname(options.artifactPath), { recursive: true });
      await writeFile(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    }

    console.log(JSON.stringify(artifact, null, 2));

    if (artifact.status === "fail") {
      process.exit(1);
    }
  } finally {
    await Effect.runPromise(engine.close);
  }
}

await main();
