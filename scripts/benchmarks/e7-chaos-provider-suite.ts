#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
  ChaosProviderSuiteArtifactSchema,
  ChaosProviderSuiteInputSchema,
  runChaosProviderSuite,
} from "../../libs/foundation/core/src/chaos-provider-suite-runtime.ts";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const ChaosProviderSuiteCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
});

type ChaosProviderSuiteCliOptions = Schema.Schema.Type<typeof ChaosProviderSuiteCliOptionsSchema>;
type ChaosProviderSuiteCliDependencies = {
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

function makeTarget(input: { readonly id: string; readonly kind: "productPage" | "searchResult" }) {
  return Schema.decodeUnknownSync(TargetProfileSchema)({
    id: input.id,
    tenantId: "tenant-main",
    domain: "example.com",
    kind: input.kind,
    canonicalKey: `catalog/${input.id}`,
    seedUrls: [`https://example.com/${input.id}`],
    accessPolicyId: "policy-hybrid-main",
    packId: "pack-example-com",
    priority: 10,
  });
}

function makePack() {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: "pack-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "active",
    accessPolicyId: "policy-hybrid-main",
    version: "2026.03.08",
  });
}

function makeAccessPolicy() {
  return Schema.decodeUnknownSync(AccessPolicySchema)({
    id: "policy-hybrid-main",
    mode: "hybrid",
    perDomainConcurrency: 8,
    globalConcurrency: 64,
    timeoutMs: 30_000,
    maxRetries: 2,
    render: "onDemand",
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

  return Schema.decodeUnknownSync(ChaosProviderSuiteCliOptionsSchema)({
    artifactPath,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

export function createDefaultChaosProviderSuite() {
  const pack = makePack();
  const accessPolicy = makeAccessPolicy();

  return Schema.decodeUnknownSync(ChaosProviderSuiteInputSchema)({
    suiteId: "suite-e7-chaos-provider",
    generatedAt: "2026-03-08T18:00:00.000Z",
    scenarios: [
      {
        scenarioId: "scenario-provider-outage",
        target: makeTarget({
          id: "target-provider-outage",
          kind: "productPage",
        }),
        pack,
        accessPolicy,
        createdAt: "2026-03-08T18:00:00.000Z",
        failureContext: {
          recentFailureCount: 2,
          lastFailureCode: "provider_unavailable",
        },
        validation: {
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: true,
            chaos: false,
            securityRedaction: true,
            soakStability: false,
          },
          metrics: {
            fieldRecallDelta: 0.01,
            falsePositiveDelta: 0.01,
            driftDelta: 0.03,
            latencyDeltaMs: 30,
            memoryDelta: 4,
          },
        },
        expected: {
          provider: "browser",
          action: "quarantined",
          failedStages: ["chaos"],
        },
      },
      {
        scenarioId: "scenario-network-timeout",
        target: makeTarget({
          id: "target-network-timeout",
          kind: "productPage",
        }),
        pack,
        accessPolicy,
        createdAt: "2026-03-08T18:00:00.000Z",
        failureContext: {
          recentFailureCount: 1,
          lastFailureCode: "timeout",
        },
        validation: {
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: false,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          metrics: {
            fieldRecallDelta: 0.01,
            falsePositiveDelta: 0.01,
            driftDelta: 0.12,
            latencyDeltaMs: 320,
            memoryDelta: 4,
          },
        },
        expected: {
          provider: "browser",
          action: "guarded",
          failedStages: ["canary"],
        },
      },
      {
        scenarioId: "scenario-throttling-window",
        target: makeTarget({
          id: "target-throttling-window",
          kind: "searchResult",
        }),
        pack,
        accessPolicy,
        createdAt: "2026-03-08T18:00:00.000Z",
        failureContext: {
          recentFailureCount: 2,
        },
        validation: {
          checks: {
            replayDeterminism: true,
            workflowResume: true,
            canary: false,
            chaos: true,
            securityRedaction: true,
            soakStability: true,
          },
          metrics: {
            fieldRecallDelta: 0.01,
            falsePositiveDelta: 0.01,
            driftDelta: 0.14,
            latencyDeltaMs: 360,
            memoryDelta: 5,
          },
        },
        expected: {
          provider: "browser",
          action: "guarded",
          failedStages: ["canary"],
        },
      },
    ],
  });
}

export async function runDefaultChaosProviderSuite(options: ChaosProviderSuiteCliOptions = {}) {
  const artifact = await Effect.runPromise(
    runChaosProviderSuite(createDefaultChaosProviderSuite()),
  );

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(ChaosProviderSuiteArtifactSchema)(artifact);
}

export async function runChaosProviderSuiteCli(
  args: readonly string[],
  dependencies: ChaosProviderSuiteCliDependencies = {},
) {
  const setExitCode =
    dependencies.setExitCode ?? ((code: number) => void (process.exitCode = code));
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultChaosProviderSuite(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(
      readCauseMessage(cause, "Failed to run the E7 chaos provider degradation suite."),
    );
  }
}

if (import.meta.main) {
  await runChaosProviderSuiteCli(process.argv.slice(2));
}
