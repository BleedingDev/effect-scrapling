#!/usr/bin/env bun

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

function runCommand(cmd: string[], cwd = process.cwd()): CommandResult {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
    exitCode: proc.exitCode,
  };
}

function usage(): void {
  console.log(`effect-scrapling standalone

Usage:
  standalone help
  standalone status
  standalone sync
  standalone doctor
`);
}

function readCount(tool: "bd" | "br"): number {
  const args = tool === "bd" ? [tool, "--allow-stale", "--json", "count"] : [tool, "--json", "count"];
  const result = runCommand(args);
  if (!result.ok) {
    throw new Error(`${tool} count failed: ${result.stderr || result.stdout}`.trim());
  }
  const parsed = JSON.parse(result.stdout) as { count: number };
  return parsed.count;
}

function printStatus(): void {
  const bdCount = readCount("bd");
  const brCount = readCount("br");
  const payload = {
    ok: true,
    bdCount,
    brCount,
    parity: bdCount === brCount,
  };
  console.log(JSON.stringify(payload, null, 2));
}

function runSync(): void {
  const result = runCommand(["scripts/beads-stabilize.sh"]);
  if (!result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode || 1);
  }
  if (result.stdout) process.stdout.write(result.stdout);
}

function runDoctor(): void {
  const bd = runCommand(["bd", "--allow-stale", "doctor"]);
  const br = runCommand(["br", "doctor"]);

  if (bd.stdout) process.stdout.write(bd.stdout);
  if (bd.stderr) process.stderr.write(bd.stderr);
  if (br.stdout) process.stdout.write(br.stdout);
  if (br.stderr) process.stderr.write(br.stderr);

  if (!bd.ok || !br.ok) {
    process.exit(1);
  }
}

const command = process.argv[2] ?? "help";

switch (command) {
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  case "status":
    printStatus();
    break;
  case "sync":
    runSync();
    break;
  case "doctor":
    runDoctor();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(2);
}
