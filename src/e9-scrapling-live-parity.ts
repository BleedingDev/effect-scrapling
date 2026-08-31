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
import {
  buildProductIdentity,
  detectProductIdentitySignals,
  tokenizeProductIdentity,
  type E9ProductIdentitySignals,
} from "./e9-product-identity.ts";

const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const NonNegativeNumberSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const UnitIntervalSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);
const MeasurementModeSchema = Schema.Literal("live-upstream-cli-turnstile");
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LIVE_BROWSER_TIMEOUT_MS = 60_000;
const LIVE_POST_NAVIGATION_WAIT_MS = 2_000;
const DISALLOWED_EXTRA_STATUS_TOKENS = new Set([
  "bazar",
  "openbox",
  "open-box",
  "pouzity",
  "pouzite",
  "pouzita",
  "refurbished",
  "renewed",
  "rozbalene",
  "used",
]);
export const E9_EFFECT_SCRAPLING_LIVE_COMMAND =
  "bun run src/standalone.ts extract run --mode browser --provider browser-stealth --network-idle --timeout 60000 --wait 2000 --wait-selector h1 --solve-cloudflare";
export const E9_UPSTREAM_SCRAPLING_LIVE_COMMAND =
  "scrapling extract stealthy-fetch --real-chrome --block-webrtc --hide-canvas --solve-cloudflare --network-idle --timeout 60000 --wait 2000 --wait-selector h1 --css-selector h1";

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
const NonEmptyLiveCaseArraySchema = Schema.Array(E9ScraplingLiveParityCaseInputSchema).pipe(
  Schema.refine(
    (cases): cases is readonly [LiveCaseInput, ...LiveCaseInput[]] => cases.length > 0,
    {
      message: "Expected at least one live parity case.",
    },
  ),
);

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

type PythonCommandCandidate = ReadonlyArray<string>;
type EffectScraplingLiveParityInput = Pick<LiveCaseInput, "expectedValue" | "requiresBypass">;

const DEFAULT_LIVE_CASES = Schema.decodeUnknownSync(
  Schema.Array(E9ScraplingLiveParityCaseInputSchema).pipe(
    Schema.refine((cases): cases is ReadonlyArray<LiveCaseInput> => cases.length === 3, {
      message: "Expected a deterministic 3-case live Turnstile parity corpus.",
    }),
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
  {
    caseId: "case-e9-live-alza-smart-heater-h300-redirect",
    retailer: "alza",
    entryUrl: "https://www.alza.cz/tesla-smart-heater-h300-d7911948.htm",
    selector: "h1",
    expectedValue: "Tesla Smart Air Purifier S300B",
    requiresBypass: true,
  },
]);

export function createDefaultE9ScraplingLiveParityCorpus() {
  return DEFAULT_LIVE_CASES.map((currentCase) => ({ ...currentCase }));
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

function tokenizeShebangCommand(value: string) {
  const segments = value.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
  return segments.map((segment) => segment.replace(/^["']|["']$/gu, ""));
}

function isEnvAssignmentToken(token: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token);
}

function stripEnvPrefixTokens(tokens: ReadonlyArray<string>) {
  let commandStartIndex = 0;
  while (commandStartIndex < tokens.length) {
    const token = tokens[commandStartIndex];
    if (token === undefined || token === "--") {
      commandStartIndex += 1;
      break;
    }
    if (token.startsWith("-") || isEnvAssignmentToken(token)) {
      commandStartIndex += 1;
      continue;
    }
    break;
  }

  return tokens.slice(commandStartIndex);
}

function hasSignalPresenceMismatch(
  left: E9ProductIdentitySignals,
  right: E9ProductIdentitySignals,
) {
  return (
    left.accessory.length > 0 !== right.accessory.length > 0 ||
    left.bundle.length > 0 !== right.bundle.length > 0 ||
    left.compatible.length > 0 !== right.compatible.length > 0 ||
    left.replacement.length > 0 !== right.replacement.length > 0
  );
}

function isSubset(left: ReadonlyArray<string>, right: ReadonlySet<string>) {
  return left.every((token) => right.has(token));
}

function isModelLikeToken(token: string) {
  return /\d/u.test(token);
}

function hasDisallowedExtraStatusTokens(
  baselineTokenSet: ReadonlySet<string>,
  observedTokens: ReadonlyArray<string>,
) {
  return observedTokens.some(
    (token) => !baselineTokenSet.has(token) && DISALLOWED_EXTRA_STATUS_TOKENS.has(token),
  );
}

function hasUnexpectedExtraModelTokens(
  baselineTokenSet: ReadonlySet<string>,
  observedTokens: ReadonlyArray<string>,
) {
  return observedTokens.some((token) => !baselineTokenSet.has(token) && isModelLikeToken(token));
}

function hasOnlyPrefixExtras(
  baselineTokenSet: ReadonlySet<string>,
  observedTokens: ReadonlyArray<string>,
) {
  const firstSharedTokenIndex = observedTokens.findIndex((token) => baselineTokenSet.has(token));
  if (firstSharedTokenIndex < 0) {
    return false;
  }

  return observedTokens.every(
    (token, index) => baselineTokenSet.has(token) || index < firstSharedTokenIndex,
  );
}

function toMeaningfulObservedValue(rawValue: string | undefined) {
  if (rawValue === undefined) {
    return undefined;
  }

  const trimmedValue = rawValue.trim();
  return trimmedValue === "" ? undefined : trimmedValue;
}

export async function compareE9ScraplingLiveParityTitleValues(
  expectedValue: string,
  actualValue: string,
) {
  const normalizedExpected = await normalizeComparableText(expectedValue);
  const normalizedActual = await normalizeComparableText(actualValue);

  if (normalizedExpected === normalizedActual) {
    return true;
  }

  const [expectedTokens, actualTokens, expectedSignals, actualSignals] = await Promise.all([
    Effect.runPromise(tokenizeProductIdentity(expectedValue)),
    Effect.runPromise(tokenizeProductIdentity(actualValue)),
    Effect.runPromise(detectProductIdentitySignals(expectedValue)),
    Effect.runPromise(detectProductIdentitySignals(actualValue)),
  ]);

  if (expectedTokens.length === 0 || actualTokens.length === 0) {
    return false;
  }

  if (hasSignalPresenceMismatch(expectedSignals, actualSignals)) {
    return false;
  }

  const expectedTokenSet = new Set(expectedTokens);
  const actualTokenSet = new Set(actualTokens);
  if (!isSubset(expectedTokens, actualTokenSet) || actualTokenSet.size < expectedTokenSet.size) {
    return false;
  }

  return (
    hasOnlyPrefixExtras(expectedTokenSet, actualTokens) &&
    !hasUnexpectedExtraModelTokens(expectedTokenSet, actualTokens) &&
    !hasDisallowedExtraStatusTokens(expectedTokenSet, actualTokens)
  );
}

async function compareObservedLiveParityValues(
  expectedValue: string,
  leftValue: string,
  rightValue: string,
  valuesMatchReference: boolean,
) {
  const valuesAreTextuallyEqual = await compareNormalizedLiveParityValues(leftValue, rightValue);
  if (valuesAreTextuallyEqual) {
    return true;
  }

  if (valuesMatchReference) {
    const [referenceIdentity, leftIdentity, rightIdentity] = await Promise.all([
      Effect.runPromise(buildProductIdentity({ title: expectedValue })),
      Effect.runPromise(buildProductIdentity({ title: leftValue })),
      Effect.runPromise(buildProductIdentity({ title: rightValue })),
    ]);
    const referenceModelTokens =
      referenceIdentity.normalizedModelTokens.length > 0
        ? referenceIdentity.normalizedModelTokens
        : referenceIdentity.canonicalTokens.filter(isModelLikeToken);
    const [referenceAwareLeftIdentity, referenceAwareRightIdentity] = await Promise.all([
      Effect.runPromise(
        buildProductIdentity({
          title: leftValue,
          modelTokens: referenceModelTokens,
        }),
      ),
      Effect.runPromise(
        buildProductIdentity({
          title: rightValue,
          modelTokens: referenceModelTokens,
        }),
      ),
    ]);
    const [baselineIdentity, observedIdentity] =
      leftIdentity.canonicalTokens.length <= rightIdentity.canonicalTokens.length
        ? [leftIdentity, rightIdentity]
        : [rightIdentity, leftIdentity];
    const baselineTokenSet = new Set(baselineIdentity.canonicalTokens);
    const observedTokenSet = new Set(observedIdentity.canonicalTokens);

    return (
      !hasSignalPresenceMismatch(leftIdentity.signals, rightIdentity.signals) &&
      compareNormalizedLiveParityAnchoredModels(
        referenceAwareLeftIdentity.anchoredModelTokens,
        referenceAwareRightIdentity.anchoredModelTokens,
      ) &&
      compareNormalizedLiveParityVariantTokens(
        referenceIdentity.variantTokens,
        referenceAwareLeftIdentity.variantTokens,
        referenceAwareRightIdentity.variantTokens,
      ) &&
      isSubset(baselineIdentity.canonicalTokens, observedTokenSet) &&
      hasOnlyPrefixExtras(baselineTokenSet, observedIdentity.canonicalTokens) &&
      !hasUnexpectedExtraModelTokens(baselineTokenSet, observedIdentity.canonicalTokens) &&
      !hasDisallowedExtraStatusTokens(baselineTokenSet, observedIdentity.canonicalTokens)
    );
  }

  return false;
}

function compareNormalizedLiveParityAnchoredModels(
  leftAnchoredModelTokens: ReadonlyArray<string>,
  rightAnchoredModelTokens: ReadonlyArray<string>,
) {
  if (leftAnchoredModelTokens.length !== rightAnchoredModelTokens.length) {
    return false;
  }

  const rightAnchoredModelTokenSet = new Set(rightAnchoredModelTokens);
  return leftAnchoredModelTokens.every((token) => rightAnchoredModelTokenSet.has(token));
}

async function compareNormalizedLiveParityValues(leftValue: string, rightValue: string) {
  const [normalizedLeft, normalizedRight] = await Promise.all([
    normalizeComparableText(leftValue),
    normalizeComparableText(rightValue),
  ]);
  return normalizedLeft === normalizedRight;
}

function compareNormalizedLiveParityVariantTokens(
  expectedVariantTokens: ReadonlyArray<string>,
  leftVariantTokens: ReadonlyArray<string>,
  rightVariantTokens: ReadonlyArray<string>,
) {
  if (leftVariantTokens.length !== rightVariantTokens.length) {
    return false;
  }

  const expectedVariantTokenSet = new Set(expectedVariantTokens);
  const leftVariantTokenSet = new Set(leftVariantTokens);
  const rightVariantTokenSet = new Set(rightVariantTokens);

  return (
    leftVariantTokenSet.size === rightVariantTokenSet.size &&
    [...leftVariantTokenSet].every((token) => rightVariantTokenSet.has(token)) &&
    [...leftVariantTokenSet].every((token) => expectedVariantTokenSet.has(token))
  );
}

function fragmentToText(fragment: string) {
  if (typeof DOMParser === "function") {
    const document = new DOMParser().parseFromString(fragment, "text/html");
    const text = document.body.textContent?.trim();
    if (typeof text === "string" && text !== "") {
      return text;
    }
  }

  const stripped = fragment
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
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
    "--network-idle",
    "--timeout",
    String(LIVE_BROWSER_TIMEOUT_MS),
    "--wait",
    String(LIVE_POST_NAVIGATION_WAIT_MS),
    "--wait-selector",
    input.selector,
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

  return createEffectScraplingLiveParityOutcome(
    input,
    {
      url: payload.data.url,
      values: payload.data.values,
      mediationStatus: payload.data.mediation?.status,
    },
    result.durationMs,
  );
}

export async function createEffectScraplingLiveParityOutcome(
  input: EffectScraplingLiveParityInput,
  payload: {
    readonly url: string;
    readonly values: ReadonlyArray<string>;
    readonly mediationStatus?: string;
  },
  durationMs: number,
): Promise<LiveParityOutcome> {
  const rawValue = toMeaningfulObservedValue(payload.values[0]);
  const valueMatchesReference =
    rawValue === undefined
      ? false
      : await compareE9ScraplingLiveParityTitleValues(input.expectedValue, rawValue);
  const bypassSuccess = rawValue !== undefined;

  return Schema.decodeUnknownSync(E9ScraplingLiveParityOutcomeSchema)({
    fetchSuccess: rawValue !== undefined,
    valueMatchesReference,
    bypassSuccess,
    durationMs,
    ...(rawValue === undefined ? {} : { value: rawValue }),
    finalUrl: payload.url,
    ...(payload.mediationStatus === undefined ? {} : { mediationStatus: payload.mediationStatus }),
    ...(payload.mediationStatus === undefined
      ? {}
      : { cloudflareSolved: payload.mediationStatus === "cleared" }),
    ...(rawValue === undefined ? { diagnostic: "Effect-Scrapling CLI returned no values." } : {}),
  });
}

export function extractPythonCommandCandidatesFromLauncher(launcher: string) {
  const pythonCandidates = new Array<PythonCommandCandidate>();

  const addPythonCandidate = (candidate: ReadonlyArray<string>) => {
    if (
      candidate.length === 0 ||
      pythonCandidates.some(
        (currentCandidate) =>
          currentCandidate.length === candidate.length &&
          currentCandidate.every((token, index) => token === candidate[index]),
      )
    ) {
      return;
    }

    pythonCandidates.push(candidate);
  };

  const firstLine = launcher.split(/\r?\n/u, 1)[0];
  if (typeof firstLine === "string" && firstLine.startsWith("#!")) {
    const shebang = firstLine.slice(2).trim();
    if (shebang !== "") {
      const shebangTokens = tokenizeShebangCommand(shebang).filter((token) => token !== "");
      if (shebangTokens[0] === "/usr/bin/env" || shebangTokens[0] === "env") {
        const envTokens = shebangTokens.slice(1);
        const splitModeIndex = envTokens.indexOf("-S");
        if (splitModeIndex >= 0) {
          addPythonCandidate(
            stripEnvPrefixTokens(
              tokenizeShebangCommand(envTokens.slice(splitModeIndex + 1).join(" ")).filter(
                (token) => token !== "",
              ),
            ),
          );
        } else {
          addPythonCandidate(stripEnvPrefixTokens(envTokens));
        }
      } else {
        addPythonCandidate(shebangTokens);
      }
    }
  }
  for (const pythonExecutable of ["python3", "python"] as const) {
    addPythonCandidate([pythonExecutable]);
  }

  return pythonCandidates;
}

async function resolveUpstreamScraplingVersion(upstreamCliPath: string) {
  let pythonCandidates = extractPythonCommandCandidatesFromLauncher("");

  try {
    const launcher = await readFile(upstreamCliPath, "utf8");
    pythonCandidates = extractPythonCommandCandidatesFromLauncher(launcher);
  } catch {
    // Best effort only; fall back to common interpreters below.
  }

  for (const [pythonExecutable, ...pythonExecutableArgs] of pythonCandidates) {
    try {
      const result = await runCommand(pythonExecutable, [
        ...pythonExecutableArgs,
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
    ourCommand: E9_EFFECT_SCRAPLING_LIVE_COMMAND,
    upstreamCommand: E9_UPSTREAM_SCRAPLING_LIVE_COMMAND,
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
      "--real-chrome",
      "--block-webrtc",
      "--hide-canvas",
      "--solve-cloudflare",
      "--network-idle",
      "--timeout",
      String(LIVE_BROWSER_TIMEOUT_MS),
      "--wait",
      String(LIVE_POST_NAVIGATION_WAIT_MS),
      "--wait-selector",
      input.selector,
      "--css-selector",
      input.selector,
      input.entryUrl,
      outputPath,
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

    let fragment: string;
    try {
      fragment = await readFile(outputPath, "utf8");
    } catch (error) {
      return Schema.decodeUnknownSync(E9ScraplingLiveParityOutcomeSchema)({
        fetchSuccess: false,
        valueMatchesReference: false,
        bypassSuccess: false,
        durationMs: result.durationMs,
        ...(getLastFetchedUrl(result.stderr) === undefined
          ? {}
          : { finalUrl: getLastFetchedUrl(result.stderr) }),
        diagnostic: `Upstream Scrapling CLI exited successfully but no output artifact was readable: ${String(error)}`,
      });
    }
    const rawValue = fragmentToText(fragment);
    const valueMatchesReference =
      rawValue === undefined
        ? false
        : await compareE9ScraplingLiveParityTitleValues(input.expectedValue, rawValue);
    const bypassSuccess = input.requiresBypass ? rawValue !== undefined : rawValue !== undefined;

    return Schema.decodeUnknownSync(E9ScraplingLiveParityOutcomeSchema)({
      fetchSuccess: rawValue !== undefined,
      valueMatchesReference,
      bypassSuccess,
      durationMs: result.durationMs,
      ...(rawValue === undefined ? {} : { value: rawValue }),
      ...(getLastFetchedUrl(result.stderr) === undefined
        ? {}
        : { finalUrl: getLastFetchedUrl(result.stderr) }),
      ...(result.stderr.includes("Cloudflare captcha is solved") ? { cloudflareSolved: true } : {}),
      ...(rawValue === undefined
        ? { diagnostic: "Upstream Scrapling CLI returned no values." }
        : {}),
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
  const computeParityAgreementRate = (side: "ours" | "scrapling") =>
    cases.filter((currentCase) => {
      const currentOutcome = currentCase[side];
      const otherOutcome = side === "ours" ? currentCase.scrapling : currentCase.ours;

      if (!currentOutcome.fetchSuccess) {
        return false;
      }

      return otherOutcome.fetchSuccess
        ? currentCase.valueAgreement
        : currentOutcome.valueMatchesReference;
    }).length / total;
  const ours = Schema.decodeUnknownSync(E9ParitySummarySchema)({
    measurementMode: "live-upstream-cli-turnstile",
    fetchSuccessRate: cases.filter(({ ours }) => ours.fetchSuccess).length / total,
    parityAgreementRate: computeParityAgreementRate("ours"),
    bypassSuccessRate:
      highFrictionCases === 0
        ? 1
        : cases.filter(({ requiresBypass, ours }) => requiresBypass && ours.bypassSuccess).length /
          highFrictionCases,
    referenceMatchRate: cases.filter(({ ours }) => ours.valueMatchesReference).length / total,
  });
  const scrapling = Schema.decodeUnknownSync(E9ParitySummarySchema)({
    measurementMode: "live-upstream-cli-turnstile",
    fetchSuccessRate: cases.filter(({ scrapling }) => scrapling.fetchSuccess).length / total,
    parityAgreementRate: computeParityAgreementRate("scrapling"),
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
  const cases = Schema.decodeUnknownSync(NonEmptyLiveCaseArraySchema)(
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
      (await compareObservedLiveParityValues(
        currentCase.expectedValue,
        ours.value,
        scrapling.value,
        ours.valueMatchesReference && scrapling.valueMatchesReference,
      ));
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
      ({ ours, scrapling, valueAgreement }) =>
        !ours.fetchSuccess ||
        !scrapling.fetchSuccess ||
        valueAgreement ||
        !scrapling.valueMatchesReference,
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
