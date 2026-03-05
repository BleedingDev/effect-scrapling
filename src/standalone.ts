#!/usr/bin/env bun

import { Effect } from "effect";
import { ExtractionError, InvalidInputError, NetworkError } from "./sdk/errors";
import { accessPreview, extractRun, runDoctor } from "./sdk/scraper";

type ParsedArgs = {
  readonly positionals: string[];
  readonly options: Record<string, string | boolean>;
};

function usage(): void {
  console.log(`effect-scrapling (EffectTS + Bun)

Usage:
  effect-scrapling doctor
  effect-scrapling access preview --url <url> [--timeout-ms <ms>] [--user-agent "<ua>"]
  effect-scrapling extract run --url <url> [--selector "<css>"] [--attr "<name>"] [--all] [--limit <n>] [--timeout-ms <ms>] [--user-agent "<ua>"]

Examples:
  effect-scrapling access preview --url "https://example.com"
  effect-scrapling extract run --url "https://example.com" --selector "h1"
  effect-scrapling extract run --url "https://example.com" --selector "a" --attr "href" --all --limit 10
`);
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const stripped = arg.slice(2);
    if (stripped.includes("=")) {
      const [key, value] = stripped.split("=", 2);
      options[key] = value;
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

function parsePositiveInt(name: string, value: string | boolean | undefined): number | undefined {
  if (value === undefined || typeof value === "boolean") {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Option --${name} must be a positive integer`);
  }
  return parsed;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
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

  if (error instanceof NetworkError || error instanceof ExtractionError) {
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
    const doctor = await Effect.runPromise(runDoctor());
    printJson({
      ok: doctor.ok,
      command: "doctor",
      data: doctor,
      warnings: doctor.ok ? [] : ["One or more runtime checks failed"],
    });
    process.exit(doctor.ok ? 0 : 1);
  }

  if (command === "access" && subcommand === "preview") {
    const timeoutMs = parsePositiveInt("timeout-ms", parsed.options["timeout-ms"]);
    const url = parsed.options.url;
    const userAgent = parsed.options["user-agent"];
    if (typeof url !== "string") {
      throw new Error("Missing required option: --url");
    }
    const result = await Effect.runPromise(
      accessPreview({
        url,
        timeoutMs,
        userAgent: typeof userAgent === "string" ? userAgent : undefined,
      })
    );
    printJson(result);
    return;
  }

  if (command === "extract" && subcommand === "run") {
    const timeoutMs = parsePositiveInt("timeout-ms", parsed.options["timeout-ms"]);
    const limit = parsePositiveInt("limit", parsed.options.limit);
    const url = parsed.options.url;
    const selector = parsed.options.selector;
    const attr = parsed.options.attr;
    const userAgent = parsed.options["user-agent"];
    if (typeof url !== "string") {
      throw new Error("Missing required option: --url");
    }

    const result = await Effect.runPromise(
      extractRun({
        url,
        selector: typeof selector === "string" ? selector : undefined,
        attr: typeof attr === "string" ? attr : undefined,
        all: parsed.options.all === true,
        limit,
        timeoutMs,
        userAgent: typeof userAgent === "string" ? userAgent : undefined,
      })
    );
    printJson(result);
    return;
  }

  if (command === "scrape") {
    const timeoutMs = parsePositiveInt("timeout-ms", parsed.options["timeout-ms"]);
    const limit = parsePositiveInt("limit", parsed.options.limit);
    const url = parsed.options.url;
    const selector = parsed.options.selector;
    const attr = parsed.options.attr;
    if (typeof url !== "string") {
      throw new Error("Missing required option: --url");
    }
    const result = await Effect.runPromise(
      extractRun({
        url,
        selector: typeof selector === "string" ? selector : undefined,
        attr: typeof attr === "string" ? attr : undefined,
        all: parsed.options.all === true,
        limit,
        timeoutMs,
      })
    );
    printJson(result);
    return;
  }

  throw new Error(`Unknown command: ${[command, subcommand, action].filter(Boolean).join(" ")}`);
}

main().catch(printError);
