import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "@effect-native/bun-test";

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type NxGraphJson = {
  graph?: {
    nodes?: Record<string, unknown>;
  };
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const API_SOURCE_ROOT = join(REPO_ROOT, "apps", "api", "src");
const TMP_ROOT = join(REPO_ROOT, "tmp");

function runCommand(command: readonly [string, ...string[]], cwd = REPO_ROOT): CommandResult {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseProjectList(output: string): readonly string[] {
  const trimmedOutput = output.trim();
  const jsonStart = trimmedOutput.indexOf("[");
  const jsonEnd = trimmedOutput.lastIndexOf("]");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error(`Unable to locate Nx projects JSON array in output:\n${output}`);
  }

  const parsed = JSON.parse(trimmedOutput.slice(jsonStart, jsonEnd + 1)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Nx projects JSON output must be a string array.");
  }

  return parsed;
}

async function readGraphNodeNames(graphFilePath: string): Promise<ReadonlySet<string>> {
  const graphText = await readFile(graphFilePath, "utf8");
  const graphJson = JSON.parse(graphText) as NxGraphJson;
  const graphNodes = graphJson.graph?.nodes;

  if (graphNodes === undefined) {
    throw new Error(`Nx graph JSON is missing graph.nodes at ${graphFilePath}`);
  }

  return new Set(Object.keys(graphNodes));
}

async function withTemporaryPaths(
  run: (trackTemporaryPath: (path: string) => string) => Promise<void>,
): Promise<void> {
  const temporaryPaths = new Set<string>();
  const trackTemporaryPath = (path: string): string => {
    temporaryPaths.add(path);
    return path;
  };

  try {
    await run(trackTemporaryPath);
  } finally {
    await Promise.all(
      [...temporaryPaths].map((path) => rm(path, { force: true, recursive: true })),
    );
  }
}

describe("nx workspace graph and boundary verification", () => {
  it("resolves Nx projects and graph nodes deterministically", async () => {
    await withTemporaryPaths(async (trackTemporaryPath) => {
      await mkdir(TMP_ROOT, { recursive: true });
      const graphFilePath = trackTemporaryPath(
        join(TMP_ROOT, `nx-graph-guardrail-${randomUUID()}.json`),
      );
      const graphFilePathRelative = relative(REPO_ROOT, graphFilePath);

      const projectsRun = runCommand(["bunx", "--bun", "nx", "show", "projects", "--json"]);
      expect(projectsRun.status).toBe(0);

      const projects = parseProjectList(projectsRun.stdout);
      expect(projects.length).toBeGreaterThan(0);

      const graphRun = runCommand([
        "bunx",
        "--bun",
        "nx",
        "graph",
        `--file=${graphFilePathRelative}`,
        "--open=false",
      ]);
      expect(graphRun.status).toBe(0);

      const graphNodeNames = await readGraphNodeNames(graphFilePath);
      for (const projectName of projects) {
        expect(graphNodeNames.has(projectName)).toBe(true);
      }
    });
  });

  it("rejects illegal type:app to type:tool imports via boundary enforcement", async () => {
    await withTemporaryPaths(async (trackTemporaryPath) => {
      const fixtureFilePath = trackTemporaryPath(
        join(API_SOURCE_ROOT, `__nx-boundary-fixture-${randomUUID()}.ts`),
      );
      const fixtureFilePathRelative = relative(REPO_ROOT, fixtureFilePath);

      await writeFile(
        fixtureFilePath,
        'import { reportProjectHealth } from "@effect-scrapling/ci-tooling";\n\nexport const illegalBoundaryFixture = reportProjectHealth;\n',
        "utf8",
      );

      const lintRun = runCommand(["bunx", "--bun", "oxlint", fixtureFilePathRelative]);
      expect(lintRun.status).toBe(1);

      const combinedOutput = `${lintRun.stdout}\n${lintRun.stderr}`;
      expect(combinedOutput).toContain("@nx(enforce-module-boundaries)");
      expect(combinedOutput).toContain(
        'A project tagged with "type:app" can only depend on libs tagged with "type:lib"',
      );
      expect(combinedOutput).toContain(fixtureFilePathRelative);
    });
  });
});
