#!/usr/bin/env bun

import { Cause, Effect, Exit, Option } from "effect";
import { runWorkspaceDoctor, showWorkspaceConfig } from "./e8.ts";
import {
  isBrowserError,
  isExtractionError,
  isInvalidInputError,
  isNetworkError,
} from "./sdk/error-guards.ts";
import { InvalidInputError } from "./sdk/errors.ts";
import {
  accessPreview,
  extractRun,
  FetchService,
  FetchServiceLive,
  type FetchClient,
  renderPreview,
} from "./sdk/scraper.ts";

type ParsedArgs = {
  readonly positionals: string[];
  readonly options: Record<string, string | boolean>;
};

const USAGE_TEXT = `effect-scrapling (EffectTS + Bun)

Usage:
  effect-scrapling doctor
  effect-scrapling workspace doctor
  effect-scrapling workspace config show
  effect-scrapling access preview --url <url> [--timeout-ms <ms>] [--user-agent "<ua>"] [--mode <http|browser>] [--wait-until <load|domcontentloaded|networkidle|commit>] [--wait-ms <ms>] [--browser-user-agent "<ua>"]
  effect-scrapling render preview --url <url> [--timeout-ms <ms>] [--user-agent "<ua>"] [--wait-until <load|domcontentloaded|networkidle|commit>] [--wait-ms <ms>] [--browser-user-agent "<ua>"]
  effect-scrapling extract run --url <url> [--selector "<css>"] [--attr "<name>"] [--all[=true|false]] [--limit <n>] [--timeout-ms <ms>] [--user-agent "<ua>"] [--mode <http|browser>] [--wait-until <load|domcontentloaded|networkidle|commit>] [--wait-ms <ms>] [--browser-user-agent "<ua>"]

Examples:
  effect-scrapling workspace doctor
  effect-scrapling workspace config show
  effect-scrapling access preview --url "https://example.com"
  effect-scrapling access preview --url "https://example.com" --mode browser --wait-until networkidle --wait-ms 300
  effect-scrapling render preview --url "https://example.com" --wait-until networkidle --wait-ms 300
  effect-scrapling extract run --url "https://example.com" --selector "h1"
  effect-scrapling extract run --url "https://example.com" --selector "a" --attr "href" --all --limit 10 --mode browser --wait-until load
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

function parseFlagOrValue(
  name: string,
  value: string | boolean | undefined,
): string | boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidInputError({
      message: `Option --${name} cannot be empty`,
    });
  }

  return trimmed;
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

function provideFetchService<A, E>(
  effect: Effect.Effect<A, E, FetchService>,
  fetchClient?: FetchClient,
): Effect.Effect<A, E, never> {
  if (fetchClient) {
    return effect.pipe(
      Effect.provideService(FetchService, {
        fetch: fetchClient,
      }),
    );
  }

  return effect.pipe(Effect.provide(FetchServiceLive));
}

function encodeCliJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export type CliExecutionResult = {
  readonly exitCode: number;
  readonly output: string;
};

function toCliErrorResult(error: unknown): CliExecutionResult {
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
): Promise<CliExecutionResult> {
  const parsed = parseArgs(args);
  const [command, subcommand, action] = parsed.positionals;

  try {
    if (!command || command === "help" || command === "--help" || command === "-h") {
      return { exitCode: 0, output: USAGE_TEXT };
    }

    if (command === "doctor" || (command === "workspace" && subcommand === "doctor")) {
      const doctor = await runEffect(runWorkspaceDoctor());
      return { exitCode: doctor.ok ? 0 : 1, output: encodeCliJson(doctor) };
    }

    if (command === "workspace" && subcommand === "config" && action === "show") {
      const config = await runEffect(showWorkspaceConfig());
      return { exitCode: 0, output: encodeCliJson(config) };
    }

    if (command === "access" && subcommand === "preview") {
      const url = parseNonEmptyString("url", getOption(parsed.options, "url"));
      const timeoutMs = parseNonEmptyString(
        "timeout-ms",
        getOption(parsed.options, "timeout-ms", "timeoutMs"),
      );
      const userAgent = parseNonEmptyString(
        "user-agent",
        getOption(parsed.options, "user-agent", "userAgent"),
      );
      const mode = parseNonEmptyString("mode", getOption(parsed.options, "mode"));
      const waitUntil = parseNonEmptyString(
        "wait-until",
        getOption(parsed.options, "wait-until", "waitUntil"),
      );
      const waitMs = parseNonEmptyString(
        "wait-ms",
        getOption(parsed.options, "wait-ms", "waitMs", "browser-timeout-ms", "browserTimeoutMs"),
      );
      const browserUserAgent = parseNonEmptyString(
        "browser-user-agent",
        getOption(parsed.options, "browser-user-agent", "browserUserAgent"),
      );
      if (url === undefined) {
        throw new InvalidInputError({ message: "Missing required option: --url" });
      }

      const payload: Record<string, unknown> = { url };
      if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
      if (userAgent !== undefined) payload.userAgent = userAgent;
      if (mode !== undefined) payload.mode = mode;

      const browser: Record<string, unknown> = {};
      if (waitUntil !== undefined) browser.waitUntil = waitUntil;
      if (waitMs !== undefined) browser.timeoutMs = waitMs;
      if (browserUserAgent !== undefined) browser.userAgent = browserUserAgent;
      if (Object.keys(browser).length > 0) payload.browser = browser;

      const result = await runEffect(provideFetchService(accessPreview(payload), fetchClient));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if (command === "render" && subcommand === "preview") {
      const url = parseNonEmptyString("url", getOption(parsed.options, "url"));
      const timeoutMs = parseNonEmptyString(
        "timeout-ms",
        getOption(parsed.options, "timeout-ms", "timeoutMs"),
      );
      const userAgent = parseNonEmptyString(
        "user-agent",
        getOption(parsed.options, "user-agent", "userAgent"),
      );
      const waitUntil = parseNonEmptyString(
        "wait-until",
        getOption(parsed.options, "wait-until", "waitUntil"),
      );
      const waitMs = parseNonEmptyString(
        "wait-ms",
        getOption(parsed.options, "wait-ms", "waitMs", "browser-timeout-ms", "browserTimeoutMs"),
      );
      const browserUserAgent = parseNonEmptyString(
        "browser-user-agent",
        getOption(parsed.options, "browser-user-agent", "browserUserAgent"),
      );
      if (url === undefined) {
        throw new InvalidInputError({ message: "Missing required option: --url" });
      }

      const payload: Record<string, unknown> = { url };
      if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
      if (userAgent !== undefined) payload.userAgent = userAgent;

      const browser: Record<string, unknown> = {};
      if (waitUntil !== undefined) browser.waitUntil = waitUntil;
      if (waitMs !== undefined) browser.timeoutMs = waitMs;
      if (browserUserAgent !== undefined) browser.userAgent = browserUserAgent;
      if (Object.keys(browser).length > 0) payload.browser = browser;

      const result = await runEffect(provideFetchService(renderPreview(payload), fetchClient));
      return { exitCode: 0, output: encodeCliJson(result) };
    }

    if ((command === "extract" && subcommand === "run") || command === "scrape") {
      const url = parseNonEmptyString("url", getOption(parsed.options, "url"));
      const selector = parseNonEmptyString("selector", getOption(parsed.options, "selector"));
      const attr = parseNonEmptyString("attr", getOption(parsed.options, "attr"));
      const all = parseFlagOrValue("all", getOption(parsed.options, "all"));
      const limit = parseNonEmptyString("limit", getOption(parsed.options, "limit"));
      const timeoutMs = parseNonEmptyString(
        "timeout-ms",
        getOption(parsed.options, "timeout-ms", "timeoutMs"),
      );
      const userAgent = parseNonEmptyString(
        "user-agent",
        getOption(parsed.options, "user-agent", "userAgent"),
      );
      const mode = parseNonEmptyString("mode", getOption(parsed.options, "mode"));
      const waitUntil = parseNonEmptyString(
        "wait-until",
        getOption(parsed.options, "wait-until", "waitUntil"),
      );
      const waitMs = parseNonEmptyString(
        "wait-ms",
        getOption(parsed.options, "wait-ms", "waitMs", "browser-timeout-ms", "browserTimeoutMs"),
      );
      const browserUserAgent = parseNonEmptyString(
        "browser-user-agent",
        getOption(parsed.options, "browser-user-agent", "browserUserAgent"),
      );
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
      if (mode !== undefined) payload.mode = mode;

      const browser: Record<string, unknown> = {};
      if (waitUntil !== undefined) browser.waitUntil = waitUntil;
      if (waitMs !== undefined) browser.timeoutMs = waitMs;
      if (browserUserAgent !== undefined) browser.userAgent = browserUserAgent;
      if (Object.keys(browser).length > 0) payload.browser = browser;

      const result = await runEffect(provideFetchService(extractRun(payload), fetchClient));
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

if (import.meta.main) {
  const result = await executeCli(process.argv.slice(2));
  console.log(result.output);
  process.exit(result.exitCode);
}
