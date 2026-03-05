#!/usr/bin/env bun

import { Cause, Effect, Exit, Option } from "effect";
import { BrowserError, ExtractionError, InvalidInputError, NetworkError } from "./sdk/errors";
import { accessPreview, extractRun, FetchServiceLive, runDoctor } from "./sdk/scraper";

const ACCESS_MODES = new Set(["http", "browser"]);
const BROWSER_WAIT_UNTIL_VALUES = new Set(["load", "domcontentloaded", "networkidle", "commit"]);

type ParsedArgs = {
  readonly positionals: string[];
  readonly options: Record<string, string | boolean>;
};

function usage(): void {
  console.log(`effect-scrapling (EffectTS + Bun)

Usage:
  effect-scrapling doctor
  effect-scrapling access preview --url <url> [--timeout-ms <ms>] [--user-agent "<ua>"] [--mode <http|browser>] [--wait-until <load|domcontentloaded|networkidle|commit>] [--wait-ms <ms>] [--browser-user-agent "<ua>"]
  effect-scrapling extract run --url <url> [--selector "<css>"] [--attr "<name>"] [--all[=true|false]] [--limit <n>] [--timeout-ms <ms>] [--user-agent "<ua>"] [--mode <http|browser>] [--wait-until <load|domcontentloaded|networkidle|commit>] [--wait-ms <ms>] [--browser-user-agent "<ua>"]

Examples:
  effect-scrapling access preview --url "https://example.com"
  effect-scrapling access preview --url "https://example.com" --mode browser --wait-until networkidle --wait-ms 300
  effect-scrapling extract run --url "https://example.com" --selector "h1"
  effect-scrapling extract run --url "https://example.com" --selector "a" --attr "href" --all --limit 10 --mode browser --wait-until load
`);
}

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

function parsePositiveInt(name: string, value: string | boolean | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    throw new InvalidInputError({
      message: `Option --${name} requires a value`,
    });
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidInputError({
      message: `Option --${name} must be a positive integer`,
      details: `received: ${value}`,
    });
  }
  return parsed;
}

function parseBooleanOption(
  name: string,
  value: string | boolean | undefined,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;

  throw new InvalidInputError({
    message: `Option --${name} must be a boolean`,
    details: `Use --${name}, --${name}=true, or --${name}=false`,
  });
}

type BrowserOptions = {
  readonly mode?: string;
  readonly waitUntil?: string;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
};

function parseMode(value: string | boolean | undefined): string | undefined {
  const mode = parseNonEmptyString("mode", value);
  if (mode === undefined) {
    return undefined;
  }

  if (!ACCESS_MODES.has(mode)) {
    throw new InvalidInputError({
      message: `Option --mode must be one of: ${Array.from(ACCESS_MODES).join(", ")}`,
      details: `received: ${mode}`,
    });
  }

  return mode;
}

function parseWaitUntil(value: string | boolean | undefined): string | undefined {
  const waitUntil = parseNonEmptyString("wait-until", value);
  if (waitUntil === undefined) {
    return undefined;
  }

  if (!BROWSER_WAIT_UNTIL_VALUES.has(waitUntil)) {
    throw new InvalidInputError({
      message: `Option --wait-until must be one of: ${Array.from(BROWSER_WAIT_UNTIL_VALUES).join(", ")}`,
      details: `received: ${waitUntil}`,
    });
  }

  return waitUntil;
}

function parseBrowserOptions(options: Record<string, string | boolean>): BrowserOptions {
  const mode = parseMode(getOption(options, "mode"));
  const waitUntil = parseWaitUntil(getOption(options, "wait-until", "waitUntil"));
  const timeoutMs = parsePositiveInt(
    "wait-ms",
    getOption(options, "wait-ms", "waitMs", "browser-timeout-ms", "browserTimeoutMs"),
  );
  const userAgent = parseNonEmptyString(
    "browser-user-agent",
    getOption(options, "browser-user-agent", "browserUserAgent"),
  );

  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(waitUntil !== undefined ? { waitUntil } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
  };
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
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

function printError(error: unknown): never {
  if (error instanceof InvalidInputError) {
    printJson({
      ok: false,
      code: error._tag,
      message: error.message,
      details: error.details ?? null,
    });
    process.exit(2);
  }

  if (
    error instanceof NetworkError ||
    error instanceof BrowserError ||
    error instanceof ExtractionError
  ) {
    printJson({
      ok: false,
      code: error._tag,
      message: error.message,
      details: error.details ?? null,
    });
    process.exit(1);
  }

  printJson({
    ok: false,
    code: "UnknownError",
    message: String(error),
  });
  process.exit(1);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, action] = parsed.positionals;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "doctor") {
    const doctor = await runEffect(runDoctor());
    printJson({
      ok: doctor.ok,
      command: "doctor",
      data: doctor,
      warnings: doctor.ok ? [] : ["One or more runtime checks failed"],
    });
    process.exit(doctor.ok ? 0 : 1);
  }

  if (command === "access" && subcommand === "preview") {
    const timeoutMs = parsePositiveInt(
      "timeout-ms",
      getOption(parsed.options, "timeout-ms", "timeoutMs"),
    );
    const url = parseNonEmptyString("url", getOption(parsed.options, "url"));
    const userAgent = parseNonEmptyString(
      "user-agent",
      getOption(parsed.options, "user-agent", "userAgent"),
    );
    const browserOptions = parseBrowserOptions(parsed.options);
    if (url === undefined) {
      throw new InvalidInputError({ message: "Missing required option: --url" });
    }

    const payload: Record<string, unknown> = { url };
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
    if (userAgent !== undefined) payload.userAgent = userAgent;
    if (browserOptions.mode !== undefined) payload.mode = browserOptions.mode;

    const browser: Record<string, unknown> = {};
    if (browserOptions.waitUntil !== undefined) browser.waitUntil = browserOptions.waitUntil;
    if (browserOptions.timeoutMs !== undefined) browser.timeoutMs = browserOptions.timeoutMs;
    if (browserOptions.userAgent !== undefined) browser.userAgent = browserOptions.userAgent;
    if (Object.keys(browser).length > 0) payload.browser = browser;

    const result = await runEffect(accessPreview(payload).pipe(Effect.provide(FetchServiceLive)));
    printJson(result);
    return;
  }

  if (command === "extract" && subcommand === "run") {
    const timeoutMs = parsePositiveInt(
      "timeout-ms",
      getOption(parsed.options, "timeout-ms", "timeoutMs"),
    );
    const limit = parsePositiveInt("limit", getOption(parsed.options, "limit"));
    const url = parseNonEmptyString("url", getOption(parsed.options, "url"));
    const selector = parseNonEmptyString("selector", getOption(parsed.options, "selector"));
    const attr = parseNonEmptyString("attr", getOption(parsed.options, "attr"));
    const userAgent = parseNonEmptyString(
      "user-agent",
      getOption(parsed.options, "user-agent", "userAgent"),
    );
    const all = parseBooleanOption("all", getOption(parsed.options, "all"));
    const browserOptions = parseBrowserOptions(parsed.options);
    if (url === undefined) {
      throw new InvalidInputError({ message: "Missing required option: --url" });
    }

    const payload: Record<string, unknown> = { url };
    if (selector !== undefined) payload.selector = selector;
    if (attr !== undefined) payload.attr = attr;
    if (all !== undefined) payload.all = all;
    if (limit !== undefined) payload.limit = limit;
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
    if (userAgent !== undefined) payload.userAgent = userAgent;
    if (browserOptions.mode !== undefined) payload.mode = browserOptions.mode;

    const browser: Record<string, unknown> = {};
    if (browserOptions.waitUntil !== undefined) browser.waitUntil = browserOptions.waitUntil;
    if (browserOptions.timeoutMs !== undefined) browser.timeoutMs = browserOptions.timeoutMs;
    if (browserOptions.userAgent !== undefined) browser.userAgent = browserOptions.userAgent;
    if (Object.keys(browser).length > 0) payload.browser = browser;

    const result = await runEffect(extractRun(payload).pipe(Effect.provide(FetchServiceLive)));
    printJson(result);
    return;
  }

  if (command === "scrape") {
    const timeoutMs = parsePositiveInt(
      "timeout-ms",
      getOption(parsed.options, "timeout-ms", "timeoutMs"),
    );
    const limit = parsePositiveInt("limit", getOption(parsed.options, "limit"));
    const url = parseNonEmptyString("url", getOption(parsed.options, "url"));
    const selector = parseNonEmptyString("selector", getOption(parsed.options, "selector"));
    const attr = parseNonEmptyString("attr", getOption(parsed.options, "attr"));
    const all = parseBooleanOption("all", getOption(parsed.options, "all"));
    const browserOptions = parseBrowserOptions(parsed.options);
    if (url === undefined) {
      throw new InvalidInputError({ message: "Missing required option: --url" });
    }

    const payload: Record<string, unknown> = { url };
    if (selector !== undefined) payload.selector = selector;
    if (attr !== undefined) payload.attr = attr;
    if (all !== undefined) payload.all = all;
    if (limit !== undefined) payload.limit = limit;
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
    if (browserOptions.mode !== undefined) payload.mode = browserOptions.mode;

    const browser: Record<string, unknown> = {};
    if (browserOptions.waitUntil !== undefined) browser.waitUntil = browserOptions.waitUntil;
    if (browserOptions.timeoutMs !== undefined) browser.timeoutMs = browserOptions.timeoutMs;
    if (browserOptions.userAgent !== undefined) browser.userAgent = browserOptions.userAgent;
    if (Object.keys(browser).length > 0) payload.browser = browser;

    const result = await runEffect(extractRun(payload).pipe(Effect.provide(FetchServiceLive)));
    printJson(result);
    return;
  }

  throw new InvalidInputError({
    message: `Unknown command: ${[command, subcommand, action].filter(Boolean).join(" ")}`,
    details: "Run `effect-scrapling help` to list valid commands",
  });
}

main().catch(printError);
