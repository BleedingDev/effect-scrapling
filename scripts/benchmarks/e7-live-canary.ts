#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import {
  LiveCanaryArtifactSchema,
  LiveCanaryInputSchema,
  runLiveCanaryHarness,
} from "../../libs/foundation/core/src/live-canary-runtime.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const LiveCanaryCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
});

type LiveCanaryCliOptions = Schema.Schema.Type<typeof LiveCanaryCliOptionsSchema>;
type LiveCanaryCliDependencies = {
  readonly setExitCode?: (code: number) => void;
  readonly writeLine?: (line: string) => void;
};

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function makeTarget(input: { readonly id: string; readonly domain: string }) {
  return Schema.decodeUnknownSync(TargetProfileSchema)({
    id: input.id,
    tenantId: "tenant-main",
    domain: input.domain,
    kind: "productPage",
    canonicalKey: `catalog/${input.id}`,
    seedUrls: [`https://${input.domain}/products/${input.id}`],
    accessPolicyId: "policy-canary-main",
    packId: "pack-canary-example-com",
    priority: 10,
  });
}

function makePack() {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-canary-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "active",
    accessPolicyId: "policy-canary-main",
    version: "2026.03.08",
  });
}

function makeAccessPolicy() {
  return Schema.decodeUnknownSync(AccessPolicySchema)({
    id: "policy-canary-main",
    mode: "hybrid",
    perDomainConcurrency: 4,
    globalConcurrency: 16,
    timeoutMs: 20_000,
    maxRetries: 1,
    render: "onDemand",
  });
}

export function createDefaultLiveCanaryInput() {
  const pack = makePack();
  const accessPolicy = makeAccessPolicy();

  return Schema.decodeUnknownSync(LiveCanaryInputSchema)({
    suiteId: "suite-e7-live-canary",
    generatedAt: "2026-03-08T21:15:00.000Z",
    scenarios: [
      {
        scenarioId: "canary-product-http",
        authorizationId: "auth-canary-product-http",
        target: makeTarget({
          id: "widget-http",
          domain: "catalog.example.com",
        }),
        pack,
        accessPolicy,
        createdAt: "2026-03-08T21:15:00.000Z",
        notes: "Authorized low-friction product canary.",
        validation: {
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          metrics: {
            fieldRecallDelta: 0,
            falsePositiveDelta: 0,
            driftDelta: 0.01,
            latencyDeltaMs: 12,
            memoryDelta: 2,
          },
        },
      },
      {
        scenarioId: "canary-product-browser",
        authorizationId: "auth-canary-product-browser",
        target: makeTarget({
          id: "widget-browser",
          domain: "offers.example.com",
        }),
        pack,
        accessPolicy,
        createdAt: "2026-03-08T21:15:00.000Z",
        notes: "Authorized higher-friction product canary.",
        failureContext: {
          recentFailureCount: 1,
          lastFailureCode: "timeout",
        },
        validation: {
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          metrics: {
            fieldRecallDelta: 0.01,
            falsePositiveDelta: 0.01,
            driftDelta: 0.02,
            latencyDeltaMs: 18,
            memoryDelta: 3,
          },
        },
      },
    ],
  });
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--artifact") {
      const rawValue = args[index + 1];
      if (rawValue === undefined || rawValue.startsWith("--")) {
        throw new Error("Missing value for argument: --artifact");
      }

      artifactPath = Schema.decodeUnknownSync(NonEmptyStringSchema)(rawValue);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return Schema.decodeUnknownSync(LiveCanaryCliOptionsSchema)({
    artifactPath,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

export async function runDefaultLiveCanary(options: LiveCanaryCliOptions = {}) {
  const artifact = await Effect.runPromise(runLiveCanaryHarness(createDefaultLiveCanaryInput()));

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(LiveCanaryArtifactSchema)(artifact);
}

export async function runLiveCanaryCli(
  args: readonly string[],
  dependencies: LiveCanaryCliDependencies = {},
) {
  const setExitCode = dependencies.setExitCode ?? ((_code: number) => undefined);
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultLiveCanary(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E7 live canary harness."));
  }
}

if (import.meta.main) {
  await runLiveCanaryCli(process.argv.slice(2));
}
