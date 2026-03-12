#!/usr/bin/env bun

import { Cause, Effect, Exit, Option } from "effect";
import { normalizeCliPayload } from "./api-request-payload.ts";
import {
  runCrawlCompileOperation,
  runPackCreateOperation,
  runPackInspectOperation,
  runPackPromoteOperation,
  runPackValidateOperation,
  runQualityCompareOperation,
  runQualityVerifyOperation,
  runSnapshotDiffOperation,
  runTargetImportOperation,
  runTargetListOperation,
  runWorkflowInspectOperation,
  runWorkflowResumeOperation,
  runWorkflowRunOperation,
  showWorkspaceConfig,
} from "./e8.ts";
import {
  isAccessQuarantinedError,
  isAccessResourceError,
  isBrowserError,
  isExtractionError,
  isInvalidInputError,
  isNetworkError,
} from "./sdk/error-guards.ts";
import { InvalidInputError } from "./sdk/errors.ts";
import {
  AccessEngineClosedError,
  createSdkEngine,
  provideSdkEnvironment,
  type CreateSdkEngineOptions,
  type FetchClient,
  type SdkEngine,
} from "./sdk/host.ts";

type ParsedArgs = {
  readonly positionals: string[];
  readonly options: Record<string, string | boolean>;
};

const USAGE_TEXT = `effect-scrapling (EffectTS + Bun)

Usage:
  effect-scrapling doctor
  effect-scrapling workspace doctor
  effect-scrapling workspace config show
  effect-scrapling target import --input '<json>'
  effect-scrapling target list --input '<json>'
  effect-scrapling pack create --input '<json>'
  effect-scrapling pack inspect --input '<json>'
  effect-scrapling pack validate --input '<json>'
  effect-scrapling pack promote --input '<json>'
  effect-scrapling access explain --url <url> [--timeout-ms <ms>] [--mode <http|browser>] [--provider <id>] [--egress-profile <id>] [--egress-config '<json-object>'] [--identity-profile <id>] [--identity-config '<json-object>'] [--http-user-agent "<ua>"] [--browser-runtime-profile <id>] [--browser-wait-until <load|domcontentloaded|networkidle|commit>] [--browser-timeout-ms <ms>] [--browser-user-agent "<ua>"] [--solve-cloudflare[=true|false]]
  effect-scrapling access preview --url <url> [--timeout-ms <ms>] [--mode <http|browser>] [--provider <http-basic|http-impersonated|browser-basic|browser-stealth>] [--egress-profile <id>] [--egress-config '<json-object>'] [--identity-profile <id>] [--identity-config '<json-object>'] [--http-user-agent "<ua>"] [--browser-runtime-profile <id>] [--browser-wait-until <load|domcontentloaded|networkidle|commit>] [--browser-timeout-ms <ms>] [--browser-user-agent "<ua>"] [--solve-cloudflare[=true|false]]
  effect-scrapling render explain --url <url> [--timeout-ms <ms>] [--mode <browser>] [--provider <id>] [--egress-profile <id>] [--egress-config '<json-object>'] [--identity-profile <id>] [--identity-config '<json-object>'] [--browser-runtime-profile <id>] [--browser-wait-until <load|domcontentloaded|networkidle|commit>] [--browser-timeout-ms <ms>] [--browser-user-agent "<ua>"] [--solve-cloudflare[=true|false]]
  effect-scrapling render preview --url <url> [--timeout-ms <ms>] [--provider <browser-basic|browser-stealth>] [--egress-profile <id>] [--egress-config '<json-object>'] [--identity-profile <id>] [--identity-config '<json-object>'] [--browser-runtime-profile <id>] [--browser-wait-until <load|domcontentloaded|networkidle|commit>] [--browser-timeout-ms <ms>] [--browser-user-agent "<ua>"] [--solve-cloudflare[=true|false]]
  effect-scrapling extract explain --url <url> [--selector "<css>"] [--attr "<name>"] [--all[=true|false]] [--limit <n>] [--timeout-ms <ms>] [--mode <http|browser>] [--provider <id>] [--egress-profile <id>] [--egress-config '<json-object>'] [--identity-profile <id>] [--identity-config '<json-object>'] [--http-user-agent "<ua>"] [--browser-runtime-profile <id>] [--browser-wait-until <load|domcontentloaded|networkidle|commit>] [--browser-timeout-ms <ms>] [--browser-user-agent "<ua>"] [--solve-cloudflare[=true|false]]
  effect-scrapling extract run --url <url> [--selector "<css>"] [--attr "<name>"] [--all[=true|false]] [--limit <n>] [--timeout-ms <ms>] [--mode <http|browser>] [--provider <http-basic|http-impersonated|browser-basic|browser-stealth>] [--egress-profile <id>] [--egress-config '<json-object>'] [--identity-profile <id>] [--identity-config '<json-object>'] [--http-user-agent "<ua>"] [--browser-runtime-profile <id>] [--browser-wait-until <load|domcontentloaded|networkidle|commit>] [--browser-timeout-ms <ms>] [--browser-user-agent "<ua>"] [--solve-cloudflare[=true|false]]
  effect-scrapling crawl compile --input '<json>'
  effect-scrapling workflow run --input '<json>'
  effect-scrapling workflow resume --input '<json>'
  effect-scrapling workflow inspect --input '<json>'
  effect-scrapling quality diff --input '<json>'
  effect-scrapling quality verify --input '<json>'
  effect-scrapling quality compare --input '<json>'

Examples:
  effect-scrapling workspace doctor
  effect-scrapling workspace config show
  effect-scrapling access explain --url "https://example.com" --provider browser-stealth --browser-wait-until domcontentloaded
  effect-scrapling access preview --url "https://example.com"
  effect-scrapling access preview --url "https://example.com" --mode browser --provider browser-stealth --browser-wait-until domcontentloaded --browser-timeout-ms 300 --solve-cloudflare
  effect-scrapling render explain --url "https://example.com" --provider browser-basic --browser-wait-until load
  effect-scrapling render preview --url "https://example.com" --provider browser-basic --browser-wait-until load --browser-timeout-ms 300
  effect-scrapling extract explain --url "https://example.com" --selector "h1"
  effect-scrapling extract run --url "https://example.com" --selector "h1"
  effect-scrapling extract run --url "https://example.com" --selector "a" --attr "href" --all --limit 10 --mode browser --provider browser-basic --browser-wait-until load
`;

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args.at(i);
    if (arg === undefined) {
      continue;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const stripped = arg.slice(2);
    if (stripped.includes("=")) {
      const [key, rawValue] = stripped.split("=", 2);
      if (key) {
        options[key] = rawValue ?? "";
      }
      continue;
    }

    const next = args[i + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      options[stripped] = next;
      i += 1;
      continue;
    }

    options[stripped] = true;
  }

  return { positionals, options };
}

function getOption(
  options: Record<string, string | boolean>,
  ...names: string[]
): string | boolean | undefined {
  for (const name of names) {
    if (Object.hasOwn(options, name)) {
      return options[name];
    }
  }
  return undefined;
}

function parseNonEmptyString(
  name: string,
  value: string | boolean | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    throw new InvalidInputError({
      message: `Option --${name} requires a value`,
    });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidInputError({
      message: `Option --${name} cannot be empty`,
    });
  }

  return trimmed;
}

function parseJsonInput(options: Record<string, string | boolean>, name = "input"): unknown {
  const input = parseNonEmptyString(name, getOption(options, name));
  if (input === undefined) {
    throw new InvalidInputError({
      message: `Missing required option: --${name}`,
    });
  }

  try {
    return JSON.parse(input);
  } catch (error) {
    throw new InvalidInputError({
      message: `Option --${name} must be valid JSON`,
      details: String(error),
    });
  }
}

function assertAllowedOptions(
  options: Record<string, string | boolean>,
  allowedOptions: ReadonlyArray<string>,
  commandPath: ReadonlyArray<string>,
): void {
  const unsupportedOptions = Object.keys(options).filter(
    (option) => !allowedOptions.includes(option),
  );
  if (unsupportedOptions.length === 0) {
    return;
  }

  throw new InvalidInputError({
    message: `Unsupported option for ${commandPath.join(" ")}`,
    details: `Unsupported flags: ${unsupportedOptions.map((option) => `--${option}`).join(", ")}`,
  });
}

function assertNoExtraAction(action: string | undefined, commandPath: ReadonlyArray<string>): void {
  if (action !== undefined) {
    throw new InvalidInputError({
      message: `Unexpected positional segment: ${action}`,
      details: `Command ${commandPath.join(" ")} does not accept additional positional arguments`,
    });
  }
}

function unwrapFailure(cause: Cause.Cause<unknown>): unknown {
  return Option.getOrElse(Cause.findErrorOption(cause), () => new Error(Cause.pretty(cause)));
}

async function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw unwrapFailure(exit.cause);
}

function encodeCliJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

async function withAccessEngine<A>(
  run: (engine: SdkEngine) => Effect.Effect<A, unknown, never>,
  fetchClient?: FetchClient,
  engineOptions?: Omit<CreateSdkEngineOptions, "fetchClient">,
): Promise<A> {
  const engine = await Effect.runPromise(
    createSdkEngine({
      ...engineOptions,
      ...(fetchClient === undefined ? {} : { fetchClient }),
    }),
  );
  try {
    return await runEffect(run(engine));
  } finally {
    await Effect.runPromise(engine.close);
  }
}

type CliAccessEngineRunner = {
  readonly assertOpen: () => void;
  readonly use: <A>(run: (engine: SdkEngine) => Effect.Effect<A, unknown, never>) => Promise<A>;
  readonly close: () => Promise<void>;
};

function createCliAccessEngineRunner(
  fetchClient?: FetchClient,
  engineOptions?: Omit<CreateSdkEngineOptions, "fetchClient">,
): CliAccessEngineRunner {
  let closed = false;
  let enginePromise: Promise<SdkEngine> | undefined;
  let activeUses = 0;
  let waitForDrainResolve: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  const ensureOpen = () => {
    if (closed) {
      throw new AccessEngineClosedError({
        message: "CLI host is closed",
        details: "Create a new CLI host before executing additional commands.",
      });
    }
  };

  const releaseUse = () => {
    activeUses -= 1;
    if (activeUses === 0) {
      waitForDrainResolve?.();
      waitForDrainResolve = undefined;
    }
  };

  const getEngine = () => {
    ensureOpen();
    enginePromise ??= Effect.runPromise(
      createSdkEngine({
        ...engineOptions,
        ...(fetchClient === undefined ? {} : { fetchClient }),
      }),
    ).catch((error) => {
      enginePromise = undefined;
      throw error;
    });
    return enginePromise;
  };

  return {
    assertOpen: ensureOpen,
    use: async (run) => {
      ensureOpen();
      activeUses += 1;
      try {
        return await getEngine().then((engine) => runEffect(run(engine)));
      } finally {
        releaseUse();
      }
    },
    close: async () => {
      closed = true;
      closePromise ??= (async () => {
        if (activeUses > 0) {
          await new Promise<void>((resolve) => {
            waitForDrainResolve = resolve;
          });
        }

        const activeEngine = await enginePromise?.catch(() => undefined);
        enginePromise = undefined;
        if (activeEngine !== undefined) {
          await Effect.runPromise(activeEngine.close);
        }
      })();
      await closePromise;
    },
  };
}

export type CliExecutionResult = {
  readonly exitCode: number;
  readonly output: string;
};

export type CliHostEngineOptions = Omit<CreateSdkEngineOptions, "fetchClient">;

function toCliNormalizedPayload(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }

  const normalizedPayload = payload as Record<string, unknown>;
  const execution =
    typeof normalizedPayload.execution === "object" &&
    normalizedPayload.execution !== null &&
    !Array.isArray(normalizedPayload.execution)
      ? (normalizedPayload.execution as Record<string, unknown>)
      : undefined;

  if (execution?.providerId === undefined) {
    return payload;
  }

  const { providerId, ...remainingExecution } = execution;
  return {
    ...normalizedPayload,
    execution: {
      ...remainingExecution,
      driverId: providerId,
    },
  };
}

function toCliDecisionTrace(trace: {
  readonly command: string;
  readonly programId: string;
  readonly normalizedPayload: unknown;
  readonly validatedUrl: string;
  readonly defaultProviderId: string;
  readonly candidateProviderIds: ReadonlyArray<string>;
  readonly rejectedProviderIds: ReadonlyArray<string>;
  readonly appliedFallbackEdgeIds: ReadonlyArray<string>;
  readonly resolved: {
    readonly providerId: string;
    readonly fallback?:
      | {
          readonly browserOnAccessWall?:
            | ({
                readonly providerId: string;
              } & Record<string, unknown>)
            | undefined;
        }
      | undefined;
  } & Record<string, unknown>;
}) {
  const fallbackBrowser =
    trace.resolved.fallback?.browserOnAccessWall === undefined
      ? undefined
      : (() => {
          const { providerId, ...browserOnAccessWall } =
            trace.resolved.fallback.browserOnAccessWall;
          return {
            ...browserOnAccessWall,
            driverId: providerId,
          };
        })();
  const { providerId, fallback: _ignoredFallback, ...resolved } = trace.resolved;

  return {
    command: trace.command,
    programId: trace.programId,
    normalizedPayload: toCliNormalizedPayload(trace.normalizedPayload),
    validatedUrl: trace.validatedUrl,
    defaultDriverId: trace.defaultProviderId,
    candidateDriverIds: trace.candidateProviderIds,
    rejectedDriverIds: trace.rejectedProviderIds,
    appliedFallbackEdgeIds: trace.appliedFallbackEdgeIds,
    resolved: {
      ...resolved,
      driverId: providerId,
      ...(fallbackBrowser === undefined
        ? {}
        : {
            fallback: {
              browserOnAccessWall: fallbackBrowser,
            },
          }),
    },
  };
}

function toCliErrorResult(error: unknown): CliExecutionResult {
  if (error instanceof AccessEngineClosedError) {
    return {
      exitCode: 1,
      output: encodeCliJson({
        ok: false,
        code: "AccessEngineClosedError",
        message: error.message,
        details: error.details ?? null,
      }),
    };
  }

  if (isInvalidInputError(error)) {
    return {
      exitCode: 2,
      output: encodeCliJson({
        ok: false,
        code: "InvalidInputError",
        message: error.message,
        details: error.details ?? null,
      }),
    };
  }

  if (isNetworkError(error)) {
    return {
      exitCode: 1,
      output: encodeCliJson({
        ok: false,
        code: "NetworkError",
        message: error.message,
        details: error.details ?? null,
      }),
    };
  }

  if (isAccessResourceError(error)) {
    return {
      exitCode: 1,
      output: encodeCliJson({
        ok: false,
        code: "AccessResourceError",
        message: error.message,
        details: error.details ?? null,
      }),
    };
  }

  if (isAccessQuarantinedError(error)) {
    return {
      exitCode: 1,
      output: encodeCliJson({
        ok: false,
        code: "AccessQuarantinedError",
        message: error.message,
        details: error.details ?? null,
      }),
    };
  }

  if (isBrowserError(error)) {
    return {
      exitCode: 1,
      output: encodeCliJson({
        ok: false,
        code: "BrowserError",
        message: error.message,
        details: error.details ?? null,
      }),
    };
  }

  if (isExtractionError(error)) {
    return {
      exitCode: 1,
      output: encodeCliJson({
        ok: false,
        code: "ExtractionError",
        message: error.message,
        details: error.details ?? null,
      }),
    };
  }

  return {
    exitCode: 1,
    output: encodeCliJson({
      ok: false,
      code: "UnknownError",
      message: String(error),
    }),
  };
}

export async function executeCli(
  args: string[],
  fetchClient?: FetchClient,
  engineOptions?: CliHostEngineOptions,
): Promise<CliExecutionResult> {
  return executeCliWithRunner(args, {
    assertOpen: () => {},
    use: (run) => withAccessEngine(run, fetchClient, engineOptions),
    close: async () => {},
  });
}

async function executeCliWithRunner(
  args: string[],
  engineRunner: CliAccessEngineRunner,
): Promise<CliExecutionResult> {
  const parsed = parseArgs(args);
  const [command, subcommand, action, extra] = parsed.positionals;

  try {
    engineRunner.assertOpen();

    if (!command || command === "help" || command === "--help" || command === "-h") {
      return { exitCode: 0, output: USAGE_TEXT };
    }

    if (command === "doctor") {
      assertNoExtraAction(subcommand, ["doctor"]);
      assertAllowedOptions(parsed.options, [], ["doctor"]);
      const doctor = await engineRunner.use((engine) => engine.runDoctor());
      return { exitCode: doctor.ok ? 0 : 1, output: encodeCliJson(doctor) };
    }

    if (command === "workspace" && subcommand === "doctor") {
      assertNoExtraAction(action, ["workspace", "doctor"]);
      assertAllowedOptions(parsed.options, [], ["workspace", "doctor"]);
      const doctor = await engineRunner.use((engine) => engine.runDoctor());
      return { exitCode: doctor.ok ? 0 : 1, output: encodeCliJson(doctor) };
    }

    if (command === "workspace" && subcommand === "config" && action === "show") {
      assertNoExtraAction(extra, ["workspace", "config", "show"]);
      assertAllowedOptions(parsed.options, [], ["workspace", "config", "show"]);
      const config = await runEffect(provideSdkEnvironment(showWorkspaceConfig()));
      return { exitCode: 0, output: encodeCliJson(config) };
    }

    if (command === "target" && subcommand === "import") {
      assertNoExtraAction(action, ["target", "import"]);
      assertAllowedOptions(parsed.options, ["input"], ["target", "import"]);
      const result = await runEffect(runTargetImportOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "target" && subcommand === "list") {
      assertNoExtraAction(action, ["target", "list"]);
      assertAllowedOptions(parsed.options, ["input"], ["target", "list"]);
      const result = await runEffect(runTargetListOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "pack" && subcommand === "create") {
      assertNoExtraAction(action, ["pack", "create"]);
      assertAllowedOptions(parsed.options, ["input"], ["pack", "create"]);
      const result = await runEffect(runPackCreateOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "pack" && subcommand === "inspect") {
      assertNoExtraAction(action, ["pack", "inspect"]);
      assertAllowedOptions(parsed.options, ["input"], ["pack", "inspect"]);
      const result = await runEffect(runPackInspectOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "pack" && subcommand === "validate") {
      assertNoExtraAction(action, ["pack", "validate"]);
      assertAllowedOptions(parsed.options, ["input"], ["pack", "validate"]);
      const result = await runEffect(runPackValidateOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "pack" && subcommand === "promote") {
      assertNoExtraAction(action, ["pack", "promote"]);
      assertAllowedOptions(parsed.options, ["input"], ["pack", "promote"]);
      const result = await runEffect(runPackPromoteOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "access" && subcommand === "preview") {
      assertNoExtraAction(action, ["access", "preview"]);
      assertAllowedOptions(
        parsed.options,
        [
          "url",
          "timeout-ms",
          "mode",
          "provider",
          "egress-profile",
          "egress-config",
          "identity-profile",
          "identity-config",
          "http-user-agent",
          "browser-runtime-profile",
          "browser-wait-until",
          "browser-timeout-ms",
          "browser-user-agent",
          "solve-cloudflare",
        ],
        ["access", "preview"],
      );
      const payload = normalizeCliPayload("access", parsed.options);
      const result = await engineRunner.use((engine) => engine.accessPreview(payload));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "access" && subcommand === "explain") {
      assertNoExtraAction(action, ["access", "explain"]);
      assertAllowedOptions(
        parsed.options,
        [
          "url",
          "timeout-ms",
          "mode",
          "provider",
          "egress-profile",
          "egress-config",
          "identity-profile",
          "identity-config",
          "http-user-agent",
          "browser-runtime-profile",
          "browser-wait-until",
          "browser-timeout-ms",
          "browser-user-agent",
          "solve-cloudflare",
        ],
        ["access", "explain"],
      );
      const payload = normalizeCliPayload("access", parsed.options);
      const result = await engineRunner.use((engine) => engine.explainAccessPreview(payload));
      return { exitCode: 0, output: encodeCliJson(toCliDecisionTrace(result)) };
    }

    if (command === "render" && subcommand === "preview") {
      assertNoExtraAction(action, ["render", "preview"]);
      assertAllowedOptions(
        parsed.options,
        [
          "url",
          "timeout-ms",
          "mode",
          "provider",
          "egress-profile",
          "egress-config",
          "identity-profile",
          "identity-config",
          "browser-runtime-profile",
          "browser-wait-until",
          "browser-timeout-ms",
          "browser-user-agent",
          "solve-cloudflare",
        ],
        ["render", "preview"],
      );
      const payload = normalizeCliPayload("render", parsed.options);
      const result = await engineRunner.use((engine) => engine.renderPreview(payload));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "render" && subcommand === "explain") {
      assertNoExtraAction(action, ["render", "explain"]);
      assertAllowedOptions(
        parsed.options,
        [
          "url",
          "timeout-ms",
          "mode",
          "provider",
          "egress-profile",
          "egress-config",
          "identity-profile",
          "identity-config",
          "browser-runtime-profile",
          "browser-wait-until",
          "browser-timeout-ms",
          "browser-user-agent",
          "solve-cloudflare",
        ],
        ["render", "explain"],
      );
      const payload = normalizeCliPayload("render", parsed.options);
      const result = await engineRunner.use((engine) => engine.explainRenderPreview(payload));
      return { exitCode: 0, output: encodeCliJson(toCliDecisionTrace(result)) };
    }

    if ((command === "extract" && subcommand === "run") || command === "scrape") {
      if (command === "extract") {
        assertNoExtraAction(action, ["extract", "run"]);
      }
      if (command === "scrape" && subcommand !== undefined) {
        throw new InvalidInputError({
          message: `Unexpected positional segment: ${subcommand}`,
          details: "Command scrape does not accept additional positional arguments",
        });
      }
      assertAllowedOptions(
        parsed.options,
        [
          "url",
          "selector",
          "attr",
          "all",
          "limit",
          "timeout-ms",
          "mode",
          "provider",
          "egress-profile",
          "egress-config",
          "identity-profile",
          "identity-config",
          "http-user-agent",
          "browser-runtime-profile",
          "browser-wait-until",
          "browser-timeout-ms",
          "browser-user-agent",
          "solve-cloudflare",
        ],
        command === "extract" ? ["extract", "run"] : ["scrape"],
      );
      const payload = normalizeCliPayload("extract", parsed.options);
      const result = await engineRunner.use((engine) => engine.extractRun(payload));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "extract" && subcommand === "explain") {
      assertNoExtraAction(action, ["extract", "explain"]);
      assertAllowedOptions(
        parsed.options,
        [
          "url",
          "selector",
          "attr",
          "all",
          "limit",
          "timeout-ms",
          "mode",
          "provider",
          "egress-profile",
          "egress-config",
          "identity-profile",
          "identity-config",
          "http-user-agent",
          "browser-runtime-profile",
          "browser-wait-until",
          "browser-timeout-ms",
          "browser-user-agent",
          "solve-cloudflare",
        ],
        ["extract", "explain"],
      );
      const payload = normalizeCliPayload("extract", parsed.options);
      const result = await engineRunner.use((engine) => engine.explainExtractRun(payload));
      return { exitCode: 0, output: encodeCliJson(toCliDecisionTrace(result)) };
    }

    if (command === "crawl" && subcommand === "compile") {
      assertNoExtraAction(action, ["crawl", "compile"]);
      assertAllowedOptions(parsed.options, ["input"], ["crawl", "compile"]);
      const result = await runEffect(runCrawlCompileOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "workflow" && subcommand === "run") {
      assertNoExtraAction(action, ["workflow", "run"]);
      assertAllowedOptions(parsed.options, ["input"], ["workflow", "run"]);
      const result = await runEffect(runWorkflowRunOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "workflow" && subcommand === "resume") {
      assertNoExtraAction(action, ["workflow", "resume"]);
      assertAllowedOptions(parsed.options, ["input"], ["workflow", "resume"]);
      const result = await runEffect(runWorkflowResumeOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "workflow" && subcommand === "inspect") {
      assertNoExtraAction(action, ["workflow", "inspect"]);
      assertAllowedOptions(parsed.options, ["input"], ["workflow", "inspect"]);
      const result = await runEffect(runWorkflowInspectOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "quality" && subcommand === "diff") {
      assertNoExtraAction(action, ["quality", "diff"]);
      assertAllowedOptions(parsed.options, ["input"], ["quality", "diff"]);
      const result = await runEffect(runSnapshotDiffOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "quality" && subcommand === "verify") {
      assertNoExtraAction(action, ["quality", "verify"]);
      assertAllowedOptions(parsed.options, ["input"], ["quality", "verify"]);
      const result = await runEffect(runQualityVerifyOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "quality" && subcommand === "compare") {
      assertNoExtraAction(action, ["quality", "compare"]);
      assertAllowedOptions(parsed.options, ["input"], ["quality", "compare"]);
      const result = await runEffect(runQualityCompareOperation(parseJsonInput(parsed.options)));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    throw new InvalidInputError({
      message: `Unknown command: ${[command, subcommand, action].filter(Boolean).join(" ")}`,
      details: "Run `effect-scrapling help` to list valid commands",
    });
  } catch (error) {
    return toCliErrorResult(error);
  }
}

export function createCliHost(
  options: {
    readonly fetchClient?: FetchClient | undefined;
    readonly engine?: CliHostEngineOptions | undefined;
  } = {},
) {
  const engineRunner = createCliAccessEngineRunner(options.fetchClient, options.engine);
  let closed = false;
  let activeCommands = 0;
  let waitForDrainResolve: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  const releaseCommand = () => {
    activeCommands -= 1;
    if (activeCommands === 0) {
      waitForDrainResolve?.();
      waitForDrainResolve = undefined;
    }
  };

  return {
    execute: async (args: string[]) => {
      if (closed) {
        return toCliErrorResult(
          new AccessEngineClosedError({
            message: "CLI host is closed",
            details: "Create a new CLI host before executing additional commands.",
          }),
        );
      }

      activeCommands += 1;
      try {
        return await executeCliWithRunner(args, engineRunner);
      } finally {
        releaseCommand();
      }
    },
    close: async () => {
      closed = true;
      closePromise ??= (async () => {
        if (activeCommands > 0) {
          await new Promise<void>((resolve) => {
            waitForDrainResolve = resolve;
          });
        }
        await engineRunner.close();
      })();
      await closePromise;
    },
  } as const;
}

if (import.meta.main) {
  const result = await executeCli(process.argv.slice(2));
  console.log(result.output);
  process.exit(result.exitCode);
}
