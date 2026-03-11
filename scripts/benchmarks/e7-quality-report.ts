#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { analyzeDriftRegression } from "../../libs/foundation/core/src/drift-regression-runtime.ts";
import {
  buildQualityReportExport,
  QualityReportArtifactSchema,
} from "../../libs/foundation/core/src/quality-report-runtime.ts";
import { evaluatePromotionGatePolicy } from "../../libs/foundation/core/src/promotion-gate-policy-runtime.ts";
import { runDefaultBaselineCorpus } from "./e7-baseline-corpus.ts";
import { runDefaultChaosProviderSuite } from "./e7-chaos-provider-suite.ts";
import { runDefaultIncumbentComparison } from "./e7-incumbent-comparison.ts";
import { runBenchmark as runPerformanceBudgetBenchmark } from "./e7-performance-budget.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());

export const QualityReportCliOptionsSchema = Schema.Struct({
  artifactPath: Schema.optional(NonEmptyStringSchema),
});

type QualityReportCliOptions = Schema.Schema.Type<typeof QualityReportCliOptionsSchema>;
type QualityReportCliDependencies = {
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

  return Schema.decodeUnknownSync(QualityReportCliOptionsSchema)({
    artifactPath,
  });
}

async function persistArtifact(artifactPath: string, artifact: unknown) {
  const resolvedPath = resolve(artifactPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return resolvedPath;
}

export async function createDefaultQualityReportInput() {
  const baselineCorpus = await runDefaultBaselineCorpus();
  const incumbentComparison = await runDefaultIncumbentComparison();
  const driftRegression = await Effect.runPromise(
    analyzeDriftRegression({
      id: "analysis-e7-quality-report",
      createdAt: "2026-03-08T19:05:00.000Z",
      comparison: incumbentComparison,
    }),
  );
  const performanceBudget = await runPerformanceBudgetBenchmark([
    "--sample-size",
    "2",
    "--warmup",
    "0",
  ]);
  const chaosProviderSuite = await runDefaultChaosProviderSuite();
  const promotionGate = await Effect.runPromise(
    evaluatePromotionGatePolicy({
      evaluationId: "promotion-e7-quality-report",
      generatedAt: "2026-03-08T19:10:00.000Z",
      quality: driftRegression,
      performance: performanceBudget,
    }),
  );

  return {
    reportId: "report-e7-quality",
    generatedAt: "2026-03-08T19:15:00.000Z",
    evidence: {
      baselineCorpus,
      incumbentComparison,
      driftRegression,
      performanceBudget,
      chaosProviderSuite,
      promotionGate,
    },
  };
}

export async function runDefaultQualityReport(options: QualityReportCliOptions = {}) {
  const artifact = await Effect.runPromise(
    buildQualityReportExport(await createDefaultQualityReportInput()),
  );

  if (options.artifactPath !== undefined) {
    await persistArtifact(options.artifactPath, artifact);
  }

  return Schema.decodeUnknownSync(QualityReportArtifactSchema)(artifact);
}

export async function runQualityReportCli(
  args: readonly string[],
  dependencies: QualityReportCliDependencies = {},
) {
  const setExitCode = dependencies.setExitCode ?? ((_code: number) => undefined);
  const writeLine = dependencies.writeLine ?? ((line: string) => console.log(line));

  try {
    const options = parseOptions(args);
    const artifact = await runDefaultQualityReport(options);
    writeLine(JSON.stringify(artifact, null, 2));
    return artifact;
  } catch (cause) {
    setExitCode(1);
    throw new Error(readCauseMessage(cause, "Failed to run the E7 quality report export harness."));
  }
}

if (import.meta.main) {
  await runQualityReportCli(process.argv.slice(2));
}
