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

function readCount(tool: "bd" | "br"): number {
  const args = tool === "bd" ? [tool, "--allow-stale", "--json", "count"] : [tool, "--json", "count"];
  const result = runCommand(args);
  if (!result.ok) {
    throw new Error(`${tool} count failed: ${result.stderr || result.stdout}`.trim());
  }
  const parsed = JSON.parse(result.stdout) as { count: number };
  return parsed.count;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const port = Number(process.env.PORT || "3000");

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "effect-scrapling-api" });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      try {
        const bdCount = readCount("bd");
        const brCount = readCount("br");
        return json({
          ok: true,
          bdCount,
          brCount,
          parity: bdCount === brCount,
        });
      } catch (error) {
        return json(
          {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
          500
        );
      }
    }

    if (req.method === "POST" && url.pathname === "/sync") {
      const result = runCommand(["scripts/beads-stabilize.sh"]);
      if (!result.ok) {
        return json(
          {
            ok: false,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          500
        );
      }
      return json({
        ok: true,
        exitCode: result.exitCode,
        stdout: result.stdout,
      });
    }

    return json(
      {
        ok: false,
        message: "Not found",
        routes: [
          "GET /health",
          "GET /status",
          "POST /sync",
        ],
      },
      404
    );
  },
});

console.log(`effect-scrapling api listening on :${port}`);
