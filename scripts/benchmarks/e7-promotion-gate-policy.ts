#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { analyzeDriftRegression } from "../../libs/foundation/core/src/drift-regression-runtime.ts";
import {
  evaluatePromotionGatePolicy,
  PromotionGateEvaluationSchema,
} from "../../libs/foundation/core/src/promotion-gate-policy-runtime.ts";
import { runDefaultIncumbentComparison } from "./e7-incumbent-comparison.ts";
import { runDefaultLiveCanary } from "./e7-live-canary.ts";
import { runBenchmark as runPerformanceBudgetBenchmark } from "./e7-performance-budget.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const PromotionGateCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
});

type PromotionGateCliOptions = Schema.Schema.Type<typeof PromotionGateCliOptionsSchema>;
type PromotionGateCliDependencies = {
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

  return Schema.decodeUnknownSync(PromotionGateCliOptionsSchema)({
    artifactPath,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

export async function createDefaultPromotionGateInput() {
  const incumbentComparison = await runDefaultIncumbentComparison();
  const quality = await Effect.runPromise(
    analyzeDriftRegression({
      id: "analysis-e7-promotion-gate",
      createdAt: "2026-03-08T19:20:00.000Z",
      comparison: incumbentComparison,
    }),
  );
  const performance = await runPerformanceBudgetBenchmark(["--sample-size", "2", "--warmup", "0"]);
  const canary = await runDefaultLiveCanary();

  return {
    evaluationId: "promotion-e7-policy",
    generatedAt: "2026-03-08T21:20:00.000Z",
    quality,
    performance,
    canary,
  };
}

export async function runDefaultPromotionGatePolicy(options: PromotionGateCliOptions = {}) {
  const artifact = await Effect.runPromise(
    evaluatePromotionGatePolicy(await createDefaultPromotionGateInput()),
  );

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(PromotionGateEvaluationSchema)(artifact);
}

export async function runPromotionGatePolicyCli(
  args: readonly string[],
  dependencies: PromotionGateCliDependencies = {},
) {
  const setExitCode =
    dependencies.setExitCode ?? ((code: number) => void (process.exitCode = code));
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultPromotionGatePolicy(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E7 promotion gate policy harness."));
  }
}

if (import.meta.main) {
  await runPromotionGatePolicyCli(process.argv.slice(2));
}
