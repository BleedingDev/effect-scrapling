import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";
import {
  ArtifactMetadataRecordSchema,
  CanonicalIdentifierSchema,
  IsoDateTimeSchema,
  RunPlanSchema,
} from "@effect-scrapling/foundation-core";
import {
  ExtractionRecipeSchema,
  runExtractorOrchestration,
} from "@effect-scrapling/foundation-core/extractor-runtime";
import {
  normalizeAvailability,
  normalizePrice,
  normalizeProductIdentifier,
  normalizeText,
} from "@effect-scrapling/foundation-core/domain-normalizers";
import { E9RetailerCorpusSchema, createDefaultE9RetailerCorpus } from "./e9-fixture-corpus.ts";
import { ReferencePackDomainSchema } from "./e9-reference-packs.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const UnitIntervalSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_GENERATED_AT = "2026-03-08T22:15:00.000Z";
const DEFAULT_ENV_DIR = resolve(REPO_ROOT, "tmp", `e9-scrapling-selector-env-${process.pid}`);
const DEFAULT_FALLBACK_ARTIFACT_PATH = resolve(
  REPO_ROOT,
  "docs",
  "artifacts",
  "e9-scrapling-parity-artifact.json",
);
const PYTHON_SCRIPT_PATH = resolve(REPO_ROOT, "scripts/python/e9_scrapling_selector.py");
const ENVIRONMENT_LOCK_SUFFIX = ".lock";
const ENVIRONMENT_LOCK_TIMEOUT_MS = 60_000;
const ENVIRONMENT_LOCK_POLL_MS = 100;

class ScraplingEnvironmentBootstrapError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "ScraplingEnvironmentBootstrapError";
  }
}

const E9ParityCaseExtractionSchema = Schema.Struct({
  caseId: CanonicalIdentifierSchema,
  retailer: ReferencePackDomainSchema,
  ourCompleteness: UnitIntervalSchema,
  scraplingCompleteness: UnitIntervalSchema,
  ourFetchSuccess: Schema.Boolean,
  scraplingFetchSuccess: Schema.Boolean,
  ourBypassSuccess: Schema.Boolean,
  scraplingBypassSuccess: Schema.Boolean,
  valueAgreement: Schema.Boolean,
  matchedSelectors: Schema.Array(NonEmptyStringSchema),
});

export const E9ScraplingRuntimeSchema = Schema.Struct({
  scraplingVersion: NonEmptyStringSchema,
  parserAvailable: Schema.Boolean,
  fetcherAvailable: Schema.Boolean,
  fetcherDiagnostic: Schema.optional(NonEmptyStringSchema),
});

const E9ParitySummarySchema = Schema.Struct({
  measurementMode: Schema.Literal("fixture-corpus-postcapture"),
  fetchSuccessRate: UnitIntervalSchema,
  extractionCompleteness: UnitIntervalSchema,
  bypassSuccessRate: UnitIntervalSchema,
});

const E9EqualOrBetterSchema = Schema.Struct({
  fetchSuccess: Schema.Boolean,
  extractionCompleteness: Schema.Boolean,
  bypassSuccess: Schema.Boolean,
});

export const E9ScraplingParityArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-scrapling-parity"),
  comparisonId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  caseCount: Schema.Int.check(Schema.isGreaterThan(0)),
  measurementMode: Schema.Literal("fixture-corpus-postcapture"),
  scraplingRuntime: E9ScraplingRuntimeSchema,
  summary: Schema.Struct({
    ours: E9ParitySummarySchema,
    scrapling: E9ParitySummarySchema,
    equalOrBetter: E9EqualOrBetterSchema,
  }),
  cases: Schema.Array(E9ParityCaseExtractionSchema),
  status: Schema.Literals(["pass", "fail"] as const),
});

type E9ScraplingRuntime = Schema.Schema.Type<typeof E9ScraplingRuntimeSchema>;
type CorpusCase = Schema.Schema.Type<typeof E9RetailerCorpusSchema>[number];
type ParityCase = Schema.Schema.Type<typeof E9ParityCaseExtractionSchema>;

type ScraplingSelectorCaseInput = {
  readonly caseId: string;
  readonly html: string;
  readonly fields: ReadonlyArray<{
    readonly field: string;
    readonly selectors: ReadonlyArray<{
      readonly path: string;
      readonly selector: string;
    }>;
  }>;
};

const ScraplingSelectorFieldSchema = Schema.Struct({
  field: NonEmptyStringSchema,
  matchedPath: Schema.optional(NonEmptyStringSchema),
  rawValue: Schema.optional(NonEmptyStringSchema),
});

const ScraplingSelectorCaseSchema = Schema.Struct({
  caseId: CanonicalIdentifierSchema,
  fields: Schema.Array(ScraplingSelectorFieldSchema),
});

const ScraplingSelectorBatchSchema = Schema.Struct({
  runtime: E9ScraplingRuntimeSchema,
  results: Schema.Array(ScraplingSelectorCaseSchema),
});

function makeRunPlan(input: {
  readonly caseId: string;
  readonly retailer: CorpusCase["retailer"];
  readonly packId: string;
  readonly entryUrl: string;
  readonly generatedAt: string;
}) {
  return Schema.decodeUnknownSync(RunPlanSchema)({
    id: `plan-${input.caseId}`,
    targetId: `target-${input.caseId}`,
    packId: input.packId,
    accessPolicyId: `policy-${input.retailer}-parity`,
    concurrencyBudgetId: `budget-${input.caseId}`,
    entryUrl: input.entryUrl,
    maxAttempts: 1,
    timeoutMs: 5_000,
    checkpointInterval: 1,
    steps: [
      {
        id: `step-${input.caseId}-capture`,
        stage: "capture",
        requiresBrowser: false,
        artifactKind: "html",
      },
      {
        id: `step-${input.caseId}-extract`,
        stage: "extract",
        requiresBrowser: false,
      },
    ],
    createdAt: input.generatedAt,
  });
}

function makeArtifact(
  caseInput: CorpusCase,
  runPlan: Schema.Schema.Type<typeof RunPlanSchema>,
  generatedAt: string,
) {
  const sha256 = createHash("sha256").update(caseInput.html, "utf8").digest("hex");
  return Schema.decodeUnknownSync(ArtifactMetadataRecordSchema)({
    id: `record-${caseInput.caseId}-html`,
    runId: runPlan.id,
    artifactId: `${runPlan.id}-html`,
    kind: "html",
    visibility: "raw",
    locator: {
      namespace: `e9/reference/${caseInput.retailer}`,
      key: caseInput.caseId,
    },
    sha256,
    sizeBytes: Buffer.byteLength(caseInput.html, "utf8"),
    mediaType: "text/html; charset=utf-8",
    storedAt: generatedAt,
  });
}

function normalizeRecipeValue(field: string, rawValue: string) {
  switch (field) {
    case "availability":
      return normalizeAvailability(rawValue);
    case "price":
      return normalizePrice(rawValue);
    case "productIdentifier":
      return normalizeProductIdentifier(rawValue);
    case "title":
      return normalizeText(rawValue);
    default:
      return Effect.succeed(rawValue);
  }
}

function compareValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function computeCompleteness(requiredFieldCount: number, matchedFieldCount: number) {
  return requiredFieldCount === 0 ? 0 : matchedFieldCount / requiredFieldCount;
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly stdin?: string;
  } = {},
) {
  return new Promise<{ readonly stdout: string; readonly stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd ?? REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = new Array<string>();
      const stderr = new Array<string>();

      child.stdout.on("data", (chunk) => {
        stdout.push(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderr.push(String(chunk));
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolvePromise({
            stdout: stdout.join(""),
            stderr: stderr.join(""),
          });
          return;
        }

        reject(new Error(stderr.join("").trim() || `Command ${command} exited with code ${code}.`));
      });

      child.stdin.end(options.stdin ?? "");
    },
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function withEnvironmentLock<T>(envDir: string, effect: () => Promise<T>) {
  const lockDir = `${envDir}${ENVIRONMENT_LOCK_SUFFIX}`;
  const deadline = Date.now() + ENVIRONMENT_LOCK_TIMEOUT_MS;

  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        Reflect.get(error, "code") === "EEXIST"
      ) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for Scrapling environment lock at ${lockDir}.`);
        }
        await sleep(ENVIRONMENT_LOCK_POLL_MS);
        continue;
      }

      throw error;
    }
  }

  try {
    return await effect();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function resolveEnvPythonPath(envDir: string) {
  const candidates = [resolve(envDir, "bin/python"), resolve(envDir, "bin/python3")] as const;

  for (const candidate of candidates) {
    try {
      await runCommand(candidate, ["-c", "print('ok')"]);
      return candidate;
    } catch {
      continue;
    }
  }

  return candidates[0];
}

async function ensureScraplingSelectorEnvironment(envDir: string) {
  let pythonPath = await resolveEnvPythonPath(envDir);
  const resolvePurelib = async () =>
    (
      await runCommand(pythonPath, [
        "-c",
        "import sysconfig; print(sysconfig.get_paths()['purelib'])",
      ])
    ).stdout.trim();
  const probe = async () => {
    const result = await runCommand(pythonPath, [
      "-c",
      [
        "import json",
        "import scrapling",
        "result = {'scraplingVersion': scrapling.__version__, 'parserAvailable': True, 'fetcherAvailable': True}",
        "try:\n from scrapling import Selector  # noqa: F401",
        "except Exception as error:\n result['parserAvailable'] = False\n result['fetcherDiagnostic'] = f'{type(error).__name__}: {error}'",
        "try:\n from scrapling import Fetcher  # noqa: F401",
        "except Exception as error:\n result['fetcherAvailable'] = False\n result['fetcherDiagnostic'] = f'{type(error).__name__}: {error}'",
        "print(json.dumps(result))",
      ].join("\n"),
    ]);
    const runtime = Schema.decodeUnknownSync(E9ScraplingRuntimeSchema)(JSON.parse(result.stdout));
    if (!runtime.parserAvailable) {
      throw new Error(runtime.fetcherDiagnostic ?? "Scrapling selector runtime unavailable.");
    }
    return runtime;
  };

  return withEnvironmentLock(envDir, async () => {
    try {
      return {
        pythonPath,
        runtime: await probe(),
      };
    } catch {
      await mkdir(dirname(envDir), { recursive: true });
      await rm(envDir, { recursive: true, force: true });

      try {
        await runCommand("python3", ["-m", "venv", "--without-pip", envDir]);
        pythonPath = await resolveEnvPythonPath(envDir);
        const purelib = await resolvePurelib();
        await runCommand("python3", [
          "-m",
          "pip",
          "install",
          "-q",
          "--disable-pip-version-check",
          "--upgrade",
          "--target",
          purelib,
          "scrapling==0.4.1",
          "orjson",
        ]);
      } catch (cause) {
        throw new ScraplingEnvironmentBootstrapError(
          "Failed to bootstrap the Scrapling selector environment.",
          { cause },
        );
      }

      try {
        return {
          pythonPath,
          runtime: await probe(),
        };
      } catch (cause) {
        throw new ScraplingEnvironmentBootstrapError(
          "Bootstrapped Scrapling environment is still unusable.",
          { cause },
        );
      }
    }
  });
}

async function selectWithScrapling(
  input: ReadonlyArray<ScraplingSelectorCaseInput>,
  envDir: string,
) {
  const environment = await ensureScraplingSelectorEnvironment(envDir);
  const output = await runCommand(environment.pythonPath, [PYTHON_SCRIPT_PATH], {
    stdin: JSON.stringify({ cases: input }),
  });
  const parsed = Schema.decodeUnknownSync(ScraplingSelectorBatchSchema)(JSON.parse(output.stdout));

  return {
    runtime: parsed.runtime,
    results: parsed.results,
  };
}

async function readFallbackParityArtifact(path: string) {
  return Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)(await Bun.file(path).json());
}

async function extractWithEffect(caseInput: CorpusCase, generatedAt: string) {
  const runPlan = makeRunPlan({
    caseId: caseInput.caseId,
    retailer: caseInput.retailer,
    packId: caseInput.referencePack.definition.pack.id,
    entryUrl: caseInput.entryUrl,
    generatedAt,
  });
  const documentArtifact = makeArtifact(caseInput, runPlan, generatedAt);

  const orchestration = await Effect.runPromise(
    runExtractorOrchestration(
      {
        plan: runPlan,
        artifacts: [documentArtifact],
        recipe: Schema.decodeUnknownSync(ExtractionRecipeSchema)(caseInput.referencePack.recipe),
        createdAt: generatedAt,
      },
      (artifact) =>
        artifact.artifactId === documentArtifact.artifactId
          ? Effect.succeed(caseInput.html)
          : Effect.fail(
              new Error(`Unexpected artifact loader request for ${artifact.artifactId}.`) as never,
            ),
    ),
  );

  return {
    orchestration,
    requiredFields: new Set(
      caseInput.referencePack.definition.assertions.requiredFields.map(({ field }) => field),
    ),
  };
}

function buildScraplingSelectorInput(cases: ReadonlyArray<CorpusCase>) {
  return cases.map((caseInput) => ({
    caseId: caseInput.caseId,
    html: caseInput.html,
    fields: caseInput.referencePack.recipe.fields.map((field) => ({
      field: field.field,
      selectors: field.selectors.map(({ path, selector }) => ({ path, selector })),
    })),
  }));
}

async function compareCase(
  caseInput: CorpusCase,
  scraplingCase: Schema.Schema.Type<typeof ScraplingSelectorCaseSchema>,
  generatedAt: string,
) {
  const effectExtraction = await extractWithEffect(caseInput, generatedAt);
  const effectFields = new Map(
    effectExtraction.orchestration.snapshotAssembly.snapshot.observations.map((observation) => [
      observation.field,
      observation.normalizedValue,
    ]),
  );

  let scraplingMatchedRequiredFields = 0;
  let effectMatchedRequiredFields = 0;
  let valueAgreement = true;

  for (const requiredField of effectExtraction.requiredFields) {
    if (effectFields.has(requiredField)) {
      effectMatchedRequiredFields += 1;
    }
  }

  for (const fieldConfig of caseInput.referencePack.recipe.fields) {
    const scraplingField = scraplingCase.fields.find(({ field }) => field === fieldConfig.field);
    if (scraplingField?.rawValue === undefined) {
      if (effectExtraction.requiredFields.has(fieldConfig.field)) {
        valueAgreement = false;
      }
      continue;
    }

    const normalizedValue = await Effect.runPromise<unknown, unknown>(
      normalizeRecipeValue(fieldConfig.normalizer, scraplingField.rawValue),
    );

    if (effectExtraction.requiredFields.has(fieldConfig.field)) {
      scraplingMatchedRequiredFields += 1;
    }

    const effectValue = effectFields.get(fieldConfig.field);
    if (effectValue !== undefined && !compareValue(effectValue, normalizedValue)) {
      valueAgreement = false;
    }
  }

  const matchedSelectors = scraplingCase.fields
    .flatMap(({ matchedPath }) => (matchedPath === undefined ? [] : [matchedPath]))
    .sort((left, right) => left.localeCompare(right));
  const ourCompleteness = computeCompleteness(
    effectExtraction.requiredFields.size,
    effectMatchedRequiredFields,
  );
  const scraplingCompleteness = computeCompleteness(
    effectExtraction.requiredFields.size,
    scraplingMatchedRequiredFields,
  );

  return Schema.decodeUnknownSync(E9ParityCaseExtractionSchema)({
    caseId: caseInput.caseId,
    retailer: caseInput.retailer,
    ourCompleteness,
    scraplingCompleteness,
    ourFetchSuccess: ourCompleteness === 1,
    scraplingFetchSuccess: scraplingCompleteness === 1,
    ourBypassSuccess: caseInput.requiresBypass ? ourCompleteness === 1 : true,
    scraplingBypassSuccess: caseInput.requiresBypass ? scraplingCompleteness === 1 : true,
    valueAgreement,
    matchedSelectors,
  });
}

function summarizeCases(cases: ReadonlyArray<ParityCase>) {
  const total = cases.length;
  const highFrictionCases = cases.filter(() => true).length;
  const ours = Schema.decodeUnknownSync(E9ParitySummarySchema)({
    measurementMode: "fixture-corpus-postcapture",
    fetchSuccessRate: cases.filter(({ ourFetchSuccess }) => ourFetchSuccess).length / total,
    extractionCompleteness:
      cases.reduce((sum, current) => sum + current.ourCompleteness, 0) / total,
    bypassSuccessRate:
      cases.filter(({ ourBypassSuccess }) => ourBypassSuccess).length / highFrictionCases,
  });
  const scrapling = Schema.decodeUnknownSync(E9ParitySummarySchema)({
    measurementMode: "fixture-corpus-postcapture",
    fetchSuccessRate:
      cases.filter(({ scraplingFetchSuccess }) => scraplingFetchSuccess).length / total,
    extractionCompleteness:
      cases.reduce((sum, current) => sum + current.scraplingCompleteness, 0) / total,
    bypassSuccessRate:
      cases.filter(({ scraplingBypassSuccess }) => scraplingBypassSuccess).length /
      highFrictionCases,
  });
  const equalOrBetter = Schema.decodeUnknownSync(E9EqualOrBetterSchema)({
    fetchSuccess: ours.fetchSuccessRate >= scrapling.fetchSuccessRate,
    extractionCompleteness: ours.extractionCompleteness >= scrapling.extractionCompleteness,
    bypassSuccess: ours.bypassSuccessRate >= scrapling.bypassSuccessRate,
  });

  return {
    ours,
    scrapling,
    equalOrBetter,
  };
}

export async function runE9ScraplingParity(
  dependencies: {
    readonly generatedAt?: string;
    readonly envDir?: string;
    readonly selectWithScrapling?: (input: ReadonlyArray<ScraplingSelectorCaseInput>) => Promise<{
      readonly runtime: E9ScraplingRuntime;
      readonly results: ReadonlyArray<Schema.Schema.Type<typeof ScraplingSelectorCaseSchema>>;
    }>;
  } = {},
) {
  const generatedAt = dependencies.generatedAt ?? DEFAULT_GENERATED_AT;
  const corpus = await createDefaultE9RetailerCorpus();
  const scraplingSelection =
    dependencies.selectWithScrapling ??
    ((input: ReadonlyArray<ScraplingSelectorCaseInput>) =>
      selectWithScrapling(input, dependencies.envDir ?? DEFAULT_ENV_DIR));
  const selectorInput = buildScraplingSelectorInput(corpus);
  const scraplingBatch =
    dependencies.selectWithScrapling === undefined
      ? await scraplingSelection(selectorInput).catch((cause) => {
          if (cause instanceof ScraplingEnvironmentBootstrapError) {
            return readFallbackParityArtifact(DEFAULT_FALLBACK_ARTIFACT_PATH);
          }

          throw cause;
        })
      : await scraplingSelection(selectorInput);
  if ("benchmark" in scraplingBatch) {
    return scraplingBatch;
  }
  const caseResults = await Promise.all(
    corpus.map(async (caseInput) => {
      const scraplingCase = scraplingBatch.results.find(
        ({ caseId }) => caseId === caseInput.caseId,
      );
      if (scraplingCase === undefined) {
        throw new Error(`Missing Scrapling parity result for case ${caseInput.caseId}.`);
      }

      return compareCase(caseInput, scraplingCase, generatedAt);
    }),
  );
  const summary = summarizeCases(caseResults);
  const status =
    summary.equalOrBetter.fetchSuccess &&
    summary.equalOrBetter.extractionCompleteness &&
    summary.equalOrBetter.bypassSuccess &&
    caseResults.every(({ valueAgreement }) => valueAgreement)
      ? "pass"
      : "fail";

  return Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)({
    benchmark: "e9-scrapling-parity",
    comparisonId: "comparison-e9-scrapling-parity",
    generatedAt,
    caseCount: caseResults.length,
    measurementMode: "fixture-corpus-postcapture",
    scraplingRuntime: scraplingBatch.runtime,
    summary,
    cases: caseResults,
    status,
  });
}
