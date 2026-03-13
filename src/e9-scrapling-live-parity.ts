import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import {
  CanonicalIdentifierSchema,
  CanonicalHttpUrlSchema,
  IsoDateTimeSchema,
} from "@effect-scrapling/foundation-core";
import { normalizeText } from "@effect-scrapling/foundation-core/domain-normalizers";
import { ExtractRunResponseSchema } from "./sdk/schemas.ts";
import { ReferencePackDomainSchema } from "./e9-reference-packs.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const NonNegativeNumberSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const UnitIntervalSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const MeasurementModeSchema = Schema.Literal("live-upstream-cli-turnstile");
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIVE_BROWSER_TIMEOUT_MS = 60_000;

export const E9ScraplingLiveParityCaseInputSchema = Schema.Struct({
  caseId: CanonicalIdentifierSchema,
  retailer: ReferencePackDomainSchema,
  entryUrl: CanonicalHttpUrlSchema,
  selector: NonEmptyStringSchema,
  expectedValue: NonEmptyStringSchema,
  requiresBypass: Schema.Boolean,
});

const E9ScraplingLiveParityRuntimeSchema = Schema.Struct({
  measurementMode: MeasurementModeSchema,
  ourCommand: NonEmptyStringSchema,
  upstreamCommand: NonEmptyStringSchema,
  upstreamCliPath: NonEmptyStringSchema,
  upstreamVersion: NonEmptyStringSchema,
});

const E9ScraplingLiveParityOutcomeSchema = Schema.Struct({
  fetchSuccess: Schema.Boolean,
  valueMatchesReference: Schema.Boolean,
  bypassSuccess: Schema.Boolean,
  durationMs: NonNegativeNumberSchema,
  value: Schema.optional(NonEmptyStringSchema),
  finalUrl: Schema.optional(CanonicalHttpUrlSchema),
  mediationStatus: Schema.optional(NonEmptyStringSchema),
  cloudflareSolved: Schema.optional(Schema.Boolean),
  diagnostic: Schema.optional(NonEmptyStringSchema),
});

const E9ScraplingLiveParityCaseSchema = Schema.Struct({
  caseId: CanonicalIdentifierSchema,
  retailer: ReferencePackDomainSchema,
  entryUrl: CanonicalHttpUrlSchema,
  selector: NonEmptyStringSchema,
  expectedValue: NonEmptyStringSchema,
  requiresBypass: Schema.Boolean,
  valueAgreement: Schema.Boolean,
  ours: E9ScraplingLiveParityOutcomeSchema,
  scrapling: E9ScraplingLiveParityOutcomeSchema,
});

const E9ParitySummarySchema = Schema.Struct({
  measurementMode: MeasurementModeSchema,
  fetchSuccessRate: UnitIntervalSchema,
  parityAgreementRate: UnitIntervalSchema,
  bypassSuccessRate: UnitIntervalSchema,
  referenceMatchRate: UnitIntervalSchema,
});

const E9EqualOrBetterSchema = Schema.Struct({
  fetchSuccess: Schema.Boolean,
  parityAgreement: Schema.Boolean,
  bypassSuccess: Schema.Boolean,
  referenceMatch: Schema.Boolean,
});

export const E9ScraplingLiveParityArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e9-scrapling-live-parity"),
  comparisonId: CanonicalIdentifierSchema,
  generatedAt: IsoDateTimeSchema,
  caseCount: Schema.Int.check(Schema.isGreaterThan(0)),
  measurementMode: MeasurementModeSchema,
  runtime: E9ScraplingLiveParityRuntimeSchema,
  summary: Schema.Struct({
    ours: E9ParitySummarySchema,
    scrapling: E9ParitySummarySchema,
    equalOrBetter: E9EqualOrBetterSchema,
  }),
  cases: Schema.Array(E9ScraplingLiveParityCaseSchema),
  status: Schema.Literals(["pass", "fail"] as const),
});

type LiveCaseInput = Schema.Schema.Type<typeof E9ScraplingLiveParityCaseInputSchema>;
type LiveParityOutcome = Schema.Schema.Type<typeof E9ScraplingLiveParityOutcomeSchema>;
type LiveParityCase = Schema.Schema.Type<typeof E9ScraplingLiveParityCaseSchema>;
type LiveParityRuntime = Schema.Schema.Type<typeof E9ScraplingLiveParityRuntimeSchema>;

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
};

const DEFAULT_LIVE_CASES = Schema.decodeUnknownSync(
  Schema.Array(E9ScraplingLiveParityCaseInputSchema).pipe(
    Schema.refine(
      (cases): cases is ReadonlyArray<LiveCaseInput> => cases.length === 2,
      {
        message: "Expected a deterministic 2-case live Turnstile parity corpus.",
      },
    ),
  ),
)([
  {
    caseId: "case-e9-live-alza-robostar-w800",
    retailer: "alza",
    entryUrl: "https://www.alza.cz/tesla-robostar-w800-wifi-d12956895.htm",
    selector: "h1",
    expectedValue: "TESLA RoboStar W800 WiFi",
    requiresBypass: true,
  },
  {
    caseId: "case-e9-live-alza-sound-eb20",
    retailer: "alza",
    entryUrl: "https://www.alza.cz/tesla-sound-eb20-d7915352.htm",
    selector: "h1",
    expectedValue: "TESLA Sound EB20 - Pearl Pink",
    requiresBypass: true,
  },
]);

export function createDefaultE9ScraplingLiveParityCorpus() {
  return [...DEFAULT_LIVE_CASES];
}

async function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
  } = {},
) {
  return new Promise<CommandResult>((resolvePromise, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
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
    child.on("close", (exitCode) => {
      resolvePromise({
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function getLastFetchedUrl(stderr: string) {
  const matches = [...stderr.matchAll(/Fetched \(\d+\) <GET (https?:\/\/[^>]+)>/gu)];
  const lastMatch = matches.at(-1);
  return lastMatch?.[1];
}

function toDiagnostic(result: CommandResult) {
  const stderr = result.stderr.trim();
  if (stderr !== "") {
    return stderr;
  }

  const stdout = result.stdout.trim();
  if (stdout !== "") {
    return stdout;
  }

  return `Command exited with code ${result.exitCode}.`;
}

async function normalizeComparableText(value: string) {
  const normalized = await Effect.runPromise(normalizeText(value));
  return normalized.trim();
}

function fragmentToText(fragment: string) {
  if (typeof DOMParser === "function") {
    const document = new DOMParser().parseFromString(fragment, "text/html");
    const text = document.body.textContent?.trim();
    if (typeof text === "string" && text !== "") {
      return text;
    }
  }

  const stripped = fragment.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
  return stripped === "" ? undefined : stripped;
}

async function runEffectScraplingCase(input: LiveCaseInput): Promise<LiveParityOutcome> {
  const result = await runCommand(process.execPath, [
    "run",
    "src/standalone.ts",
    "extract",
    "run",
    "--url",
    input.entryUrl,
    "--selector",
    input.selector,
    "--mode",
    "browser",
    "--provider",
    "browser-stealth",
    "--browser-timeout-ms",
    String(LIVE_BROWSER_TIMEOUT_MS),
    "--solve-cloudflare",
  ]);
  if (result.exitCode !== 0) {
    return Schema.decodeUnknownSync(E9ScraplingLiveParityOutcomeSchema)({
      fetchSuccess: false,
      valueMatchesReference: false,
      bypassSuccess: false,
      durationMs: result.durationMs,
      diagnostic: toDiagnostic(result),
    });
  }

  let payload: Schema.Schema.Type<typeof ExtractRunResponseSchema>;
  try {
    payload = Schema.decodeUnknownSync(ExtractRunResponseSchema)(JSON.parse(result.stdout));
  } catch (error) {
    return Schema.decodeUnknownSync(E9ScraplingLiveParityOutcomeSchema)({
      fetchSuccess: false,
      valueMatchesReference: false,
      bypassSuccess: false,
      durationMs: result.durationMs,
      diagnostic: `Failed to decode Effect-Scrapling CLI output: ${String(error)}`,
    });
  }

  const rawValue = payload.data.values[0];
  const normalizedExpected = await normalizeComparableText(input.expectedValue);
  const normalizedValue =
    rawValue === undefined ? undefined : await normalizeComparableText(rawValue);
  const valueMatchesReference =
    normalizedValue !== undefined && normalizedValue === normalizedExpected;

  return Schema.decodeUnknownSync(E9ScraplingLiveParityOutcomeSchema)({
    fetchSuccess: rawValue !== undefined,
    valueMatchesReference,
    bypassSuccess: input.requiresBypass ? valueMatchesReference : rawValue !== undefined,
    durationMs: result.durationMs,
    ...(rawValue === undefined ? {} : { value: rawValue }),
    finalUrl: payload.data.url,
    ...(payload.data.mediation?.status === undefined
      ? {}
      : { mediationStatus: payload.data.mediation.status }),
    ...(payload.data.mediation?.status === undefined
      ? {}
      : { cloudflareSolved: payload.data.mediation.status === "cleared" }),
    ...(rawValue === undefined ? { diagnostic: "Effect-Scrapling CLI returned no values." } : {}),
  });
}

async function resolveUpstreamScraplingVersion(upstreamCliPath: string) {
  const pythonCandidates = new Array<string>();

  try {
    const launcher = await readFile(upstreamCliPath, "utf8");
    const firstLine = launcher.split(/\r?\n/u, 1)[0];
    if (typeof firstLine === "string" && firstLine.startsWith("#!")) {
      const shebang = firstLine.slice(2).trim();
      if (shebang !== "") {
        pythonCandidates.push(shebang);
      }
    }
  } catch {
    // Best effort only; fall back to common interpreters below.
  }

  for (const pythonExecutable of ["python3", "python"] as const) {
    if (!pythonCandidates.includes(pythonExecutable)) {
      pythonCandidates.push(pythonExecutable);
    }
  }

  for (const pythonExecutable of pythonCandidates) {
    try {
      const result = await runCommand(pythonExecutable, [
        "-c",
        "import scrapling; print(scrapling.__version__)",
      ]);
      if (result.exitCode === 0) {
        const version = result.stdout.trim();
        if (version !== "") {
          return version;
        }
      }
    } catch {
      continue;
    }
  }

  return "unknown";
}

async function resolveRuntime() {
  const upstreamCliPath = Bun.which("scrapling");
  if (upstreamCliPath === null) {
    throw new Error("The upstream `scrapling` CLI is not installed or not available on PATH.");
  }

  return Schema.decodeUnknownSync(E9ScraplingLiveParityRuntimeSchema)({
    measurementMode: "live-upstream-cli-turnstile",
    ourCommand:
      "bun run src/standalone.ts extract run --mode browser --provider browser-stealth --solve-cloudflare",
    upstreamCommand: "scrapling extract stealthy-fetch --solve-cloudflare",
    upstreamCliPath,
    upstreamVersion: await resolveUpstreamScraplingVersion(upstreamCliPath),
  });
}

async function runUpstreamScraplingCase(
  input: LiveCaseInput,
  runtime: LiveParityRuntime,
): Promise<LiveParityOutcome> {
  const tempDir = await mkdtemp(join(tmpdir(), "e9-scrapling-live-parity-"));
  const outputPath = join(tempDir, `${input.caseId}.html`);

  try {
    const result = await runCommand(runtime.upstreamCliPath, [
      "extract",
      "stealthy-fetch",
      input.entryUrl,
      outputPath,
      "--solve-cloudflare",
      "--timeout",
      String(LIVE_BROWSER_TIMEOUT_MS),
      "--css-selector",
      input.selector,
    ]);

    if (result.exitCode !== 0) {
      return Schema.decodeUnknownSync(E9ScraplingLiveParityOutcomeSchema)({
        fetchSuccess: false,
        valueMatchesReference: false,
        bypassSuccess: false,
        durationMs: result.durationMs,
        ...(getLastFetchedUrl(result.stderr) === undefined
          ? {}
          : { finalUrl: getLastFetchedUrl(result.stderr) }),
        diagnostic: toDiagnostic(result),
      });
    }

    const fragment = await readFile(outputPath, "utf8");
    const rawValue = fragmentToText(fragment);
    const normalizedExpected = await normalizeComparableText(input.expectedValue);
    const normalizedValue =
      rawValue === undefined ? undefined : await normalizeComparableText(rawValue);
    const valueMatchesReference =
      normalizedValue !== undefined && normalizedValue === normalizedExpected;

    return Schema.decodeUnknownSync(E9ScraplingLiveParityOutcomeSchema)({
      fetchSuccess: rawValue !== undefined,
      valueMatchesReference,
      bypassSuccess: input.requiresBypass ? valueMatchesReference : rawValue !== undefined,
      durationMs: result.durationMs,
      ...(rawValue === undefined ? {} : { value: rawValue }),
      ...(getLastFetchedUrl(result.stderr) === undefined
        ? {}
        : { finalUrl: getLastFetchedUrl(result.stderr) }),
      ...(result.stderr.includes("Cloudflare captcha is solved")
        ? { cloudflareSolved: true }
        : {}),
      ...(rawValue === undefined ? { diagnostic: "Upstream Scrapling CLI returned no values." } : {}),
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function summarizeCases(
  cases: ReadonlyArray<LiveParityCase>,
): Schema.Schema.Type<typeof E9ScraplingLiveParityArtifactSchema>["summary"] {
  const total = cases.length;
  const highFrictionCases = cases.filter(({ requiresBypass }) => requiresBypass).length;
  const ours = Schema.decodeUnknownSync(E9ParitySummarySchema)({
    measurementMode: "live-upstream-cli-turnstile",
    fetchSuccessRate: cases.filter(({ ours }) => ours.fetchSuccess).length / total,
    parityAgreementRate:
      cases.filter(({ valueAgreement, ours }) => ours.fetchSuccess && valueAgreement).length / total,
    bypassSuccessRate:
      highFrictionCases === 0
        ? 1
        : cases.filter(({ requiresBypass, ours }) => requiresBypass && ours.bypassSuccess).length /
          highFrictionCases,
    referenceMatchRate:
      cases.filter(({ ours }) => ours.valueMatchesReference).length / total,
  });
  const scrapling = Schema.decodeUnknownSync(E9ParitySummarySchema)({
    measurementMode: "live-upstream-cli-turnstile",
    fetchSuccessRate: cases.filter(({ scrapling }) => scrapling.fetchSuccess).length / total,
    parityAgreementRate:
      cases.filter(({ valueAgreement, scrapling }) => scrapling.fetchSuccess && valueAgreement)
        .length / total,
    bypassSuccessRate:
      highFrictionCases === 0
        ? 1
        : cases.filter(({ requiresBypass, scrapling }) => requiresBypass && scrapling.bypassSuccess)
            .length / highFrictionCases,
    referenceMatchRate:
      cases.filter(({ scrapling }) => scrapling.valueMatchesReference).length / total,
  });
  const equalOrBetter = Schema.decodeUnknownSync(E9EqualOrBetterSchema)({
    fetchSuccess: ours.fetchSuccessRate >= scrapling.fetchSuccessRate,
    parityAgreement: ours.parityAgreementRate >= scrapling.parityAgreementRate,
    bypassSuccess: ours.bypassSuccessRate >= scrapling.bypassSuccessRate,
    referenceMatch: ours.referenceMatchRate >= scrapling.referenceMatchRate,
  });

  return {
    ours,
    scrapling,
    equalOrBetter,
  };
}

export async function runE9ScraplingLiveParity(
  dependencies: {
    readonly generatedAt?: string;
    readonly selectCases?: () => Promise<ReadonlyArray<LiveCaseInput>>;
    readonly resolveRuntime?: () => Promise<LiveParityRuntime>;
    readonly runEffectScraplingCase?: (input: LiveCaseInput) => Promise<LiveParityOutcome>;
    readonly runUpstreamScraplingCase?: (
      input: LiveCaseInput,
      runtime: LiveParityRuntime,
    ) => Promise<LiveParityOutcome>;
  } = {},
) {
  const generatedAt = dependencies.generatedAt ?? new Date().toISOString();
  const cases = Schema.decodeUnknownSync(Schema.Array(E9ScraplingLiveParityCaseInputSchema))(
    dependencies.selectCases === undefined
      ? createDefaultE9ScraplingLiveParityCorpus()
      : await dependencies.selectCases(),
  );
  const runtime =
    dependencies.resolveRuntime === undefined
      ? await resolveRuntime()
      : await dependencies.resolveRuntime();
  const runOurCase = dependencies.runEffectScraplingCase ?? runEffectScraplingCase;
  const runUpstreamCase = dependencies.runUpstreamScraplingCase ?? runUpstreamScraplingCase;

  const caseResults: LiveParityCase[] = [];
  for (const currentCase of cases) {
    const ours = await runOurCase(currentCase);
    const scrapling = await runUpstreamCase(currentCase, runtime);
    const valueAgreement =
      ours.value !== undefined &&
      scrapling.value !== undefined &&
      (await normalizeComparableText(ours.value)) === (await normalizeComparableText(scrapling.value));
    caseResults.push(
      Schema.decodeUnknownSync(E9ScraplingLiveParityCaseSchema)({
        caseId: currentCase.caseId,
        retailer: currentCase.retailer,
        entryUrl: currentCase.entryUrl,
        selector: currentCase.selector,
        expectedValue: currentCase.expectedValue,
        requiresBypass: currentCase.requiresBypass,
        valueAgreement,
        ours,
        scrapling,
      }),
    );
  }

  const summary = summarizeCases(caseResults);
  const hasComparableSuccess = caseResults.some(
    ({ ours, scrapling }) => ours.fetchSuccess && scrapling.fetchSuccess,
  );
  const hasOurReferenceAlignedSuccess = caseResults.some(
    ({ ours }) => ours.fetchSuccess && ours.valueMatchesReference,
  );
  const hasMeaningfulSuccessSignal = hasComparableSuccess || hasOurReferenceAlignedSuccess;
  const status =
    hasMeaningfulSuccessSignal &&
    hasOurReferenceAlignedSuccess &&
    summary.equalOrBetter.fetchSuccess &&
    summary.equalOrBetter.parityAgreement &&
    summary.equalOrBetter.bypassSuccess &&
    summary.equalOrBetter.referenceMatch &&
    caseResults.every(
      ({ ours, valueAgreement }) =>
        !ours.fetchSuccess || valueAgreement || ours.valueMatchesReference,
    )
      ? "pass"
      : "fail";

  return Schema.decodeUnknownSync(E9ScraplingLiveParityArtifactSchema)({
    benchmark: "e9-scrapling-live-parity",
    comparisonId: "comparison-e9-scrapling-live-parity",
    generatedAt,
    caseCount: caseResults.length,
    measurementMode: "live-upstream-cli-turnstile",
    runtime,
    summary,
    cases: caseResults,
    status,
  });
}
