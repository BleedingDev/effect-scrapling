import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "@effect-native/bun-test";
import { Predicate } from "effect";

type GateDefinition = {
  readonly name: string;
  readonly command: string;
};

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PR_AFFECTED_GATES_WORKFLOW_PATH = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "pr-affected-gates.yml",
);
const BUILD_SFE_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "build-sfe.yml");
const PROJECT_CONFIG_PATHS = [
  join(REPO_ROOT, "apps", "api", "project.json"),
  join(REPO_ROOT, "apps", "cli", "project.json"),
  join(REPO_ROOT, "libs", "foundation", "core", "project.json"),
  join(REPO_ROOT, "tools", "ci", "project.json"),
  join(REPO_ROOT, ".sf", "project.json"),
] as const;

type ProjectConfig = {
  readonly name?: string;
  readonly targets?: Record<string, { readonly options?: { readonly command?: string } }>;
};

const REQUIRED_PR_GATES: readonly GateDefinition[] = [
  {
    name: "ultracite",
    command: "bun run ultracite",
  },
  {
    name: "oxlint",
    command: "bun run oxlint",
  },
  {
    name: "oxfmt",
    command: "bun run oxfmt",
  },
  {
    name: "affected-lint",
    command: 'bun run nx affected -t lint --base="$NX_BASE" --head="$NX_HEAD" --parallel=1',
  },
  {
    name: "affected-test",
    command: 'bun run nx affected -t test --base="$NX_BASE" --head="$NX_HEAD" --parallel=1',
  },
  {
    name: "affected-typecheck",
    command: 'bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1',
  },
  {
    name: "affected-build",
    command: 'bun run nx affected -t build --base="$NX_BASE" --head="$NX_HEAD" --parallel=1',
  },
] as const;

const REQUIRED_BUILD_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
] as const;

function normalizeWorkflow(content: string): string {
  return content.replace(/\r\n/gu, "\n");
}

async function readWorkflow(path: string): Promise<string> {
  const content = await readFile(path, "utf8");
  return normalizeWorkflow(content);
}

async function readProjectConfig(path: string): Promise<ProjectConfig> {
  return JSON.parse(await readFile(path, "utf8")) as ProjectConfig;
}

function replaceExactlyOnce(content: string, target: string, replacement: string): string {
  const parts = content.split(target);
  if (parts.length !== 2) {
    throw new Error(`Expected to replace one occurrence of:\n${target}`);
  }

  return `${parts[0]}${replacement}${parts[1]}`;
}

function collectMissingSnippet(
  content: string,
  snippet: string,
  message: string,
  errors: string[],
): void {
  if (!content.includes(snippet)) {
    errors.push(message);
  }
}

function parseGateMatrix(content: string): readonly GateDefinition[] {
  const gateBlockMatch = content.match(
    /gate:\n(?<block>(?:\s+- name: [^\n]+\n\s+command: [^\n]+\n)+)/u,
  );

  if (gateBlockMatch?.groups?.block === undefined) {
    throw new Error("Unable to parse gate matrix block from pr-affected-gates workflow.");
  }

  return [
    ...gateBlockMatch.groups.block.matchAll(
      /- name: (?<name>[^\n]+)\n\s+command: (?<command>[^\n]+)/gu,
    ),
  ].map((match) => ({
    name: match.groups?.name ?? "",
    command: match.groups?.command ?? "",
  }));
}

function parseBuildTargets(content: string): readonly string[] {
  const targetBlockMatch = content.match(/target:\n(?<block>(?:\s+- [^\n]+\n)+)\s*\n\s*steps:/u);

  if (targetBlockMatch?.groups?.block === undefined) {
    throw new Error("Unable to parse build target matrix from build-sfe workflow.");
  }

  return [...targetBlockMatch.groups.block.matchAll(/- (?<target>[^\n]+)/gu)].map(
    (match) => match.groups?.target ?? "",
  );
}

function validatePrAffectedGatesWorkflow(content: string): readonly string[] {
  const errors: string[] = [];

  collectMissingSnippet(
    content,
    "uses: actions/checkout@v4",
    "Workflow must use actions/checkout@v4 for PR gate evaluation.",
    errors,
  );
  collectMissingSnippet(
    content,
    "ref: ${{ github.event.pull_request.head.sha }}",
    "Workflow must check out the pull request head SHA.",
    errors,
  );
  collectMissingSnippet(
    content,
    "fetch-depth: 0",
    "Workflow checkout must preserve full history for affected range resolution.",
    errors,
  );
  collectMissingSnippet(
    content,
    "name: pr-affected-gates",
    "Workflow name must remain pr-affected-gates.",
    errors,
  );
  collectMissingSnippet(
    content,
    "pull_request:",
    "Workflow must be triggered by pull_request events.",
    errors,
  );
  collectMissingSnippet(
    content,
    "group: pr-affected-gates-${{ github.event.pull_request.number || github.ref }}",
    "Workflow must use deterministic PR-scoped concurrency grouping.",
    errors,
  );
  collectMissingSnippet(
    content,
    "cancel-in-progress: true",
    "Workflow concurrency must cancel superseded runs.",
    errors,
  );
  collectMissingSnippet(
    content,
    "name: gate / ${{ matrix.gate.name }}",
    "Gate matrix job name must expose the gate name.",
    errors,
  );
  collectMissingSnippet(
    content,
    "fail-fast: false",
    "Gate matrix must not stop after the first failure.",
    errors,
  );
  collectMissingSnippet(
    content,
    'echo "base=${{ github.event.pull_request.base.sha }}" >> "$GITHUB_OUTPUT"',
    "Workflow must resolve NX_BASE from the pull request base SHA.",
    errors,
  );
  collectMissingSnippet(
    content,
    'echo "head=${{ github.event.pull_request.head.sha }}" >> "$GITHUB_OUTPUT"',
    "Workflow must resolve NX_HEAD from the pull request head SHA.",
    errors,
  );
  collectMissingSnippet(
    content,
    "NX_BASE: ${{ steps.range.outputs.base }}",
    "Workflow must export NX_BASE for affected gates.",
    errors,
  );
  collectMissingSnippet(
    content,
    "NX_HEAD: ${{ steps.range.outputs.head }}",
    "Workflow must export NX_HEAD for affected gates.",
    errors,
  );
  collectMissingSnippet(
    content,
    'if [[ "${{ needs.gate-matrix.result }}" != "success" ]]; then',
    "Deterministic status job must fail unless the full gate matrix succeeds.",
    errors,
  );
  collectMissingSnippet(
    content,
    "name: pr-gates-status",
    "Workflow must expose a stable aggregate status job.",
    errors,
  );
  collectMissingSnippet(content, "if: always()", "Aggregate status job must always run.", errors);
  collectMissingSnippet(
    content,
    "needs:\n      - gate-matrix",
    "Aggregate status job must depend on gate-matrix.",
    errors,
  );

  let parsedGates: readonly GateDefinition[] = [];
  try {
    parsedGates = parseGateMatrix(content);
  } catch (error) {
    errors.push(Predicate.isError(error) ? error.message : "Unable to parse PR gate matrix.");
  }

  for (const requiredGate of REQUIRED_PR_GATES) {
    const matchedGate = parsedGates.find((gate) => gate.name === requiredGate.name);

    if (matchedGate === undefined) {
      errors.push(`Missing gate "${requiredGate.name}" from gate matrix.`);
      continue;
    }

    if (matchedGate.command !== requiredGate.command) {
      errors.push(
        `Gate "${requiredGate.name}" must run "${requiredGate.command}" (found "${matchedGate.command}").`,
      );
    }
  }

  return errors;
}

function validateBuildSfeWorkflow(content: string): readonly string[] {
  const errors: string[] = [];

  collectMissingSnippet(content, "name: build-sfe", "Workflow name must remain build-sfe.", errors);
  collectMissingSnippet(
    content,
    "workflow_dispatch:",
    "Build workflow must support manual dispatch.",
    errors,
  );
  collectMissingSnippet(content, "push:", "Build workflow must run on mainline pushes.", errors);
  collectMissingSnippet(
    content,
    "      - master",
    "Build workflow must include master pushes.",
    errors,
  );
  collectMissingSnippet(
    content,
    "      - main",
    "Build workflow must include main pushes.",
    errors,
  );
  collectMissingSnippet(
    content,
    "- name: Guardrails (lint, format, type-safety)\n        if: matrix.target == 'bun-linux-x64'\n        run: bun run check",
    "Linux x64 build job must execute the full guardrail check pipeline.",
    errors,
  );
  collectMissingSnippet(
    content,
    "- name: Nx workspace checks\n        if: matrix.target == 'bun-linux-x64'\n        run: |\n          bun run nx:show-projects\n          bun run nx:lint\n          bun run nx:typecheck",
    "Linux x64 build job must run deterministic Nx workspace checks.",
    errors,
  );
  collectMissingSnippet(
    content,
    "run: bun run check:semver",
    "Build workflow must enforce semver policy.",
    errors,
  );
  collectMissingSnippet(
    content,
    "run: bun run check:publint",
    "Build workflow must run publint before compiling release assets.",
    errors,
  );
  collectMissingSnippet(
    content,
    'bun build --compile --target="$target" src/standalone.ts --outfile="dist/effect-scrapling-${target}${ext}"',
    "Build workflow must compile the standalone SFE artifact.",
    errors,
  );
  collectMissingSnippet(
    content,
    'bun build --compile --target="$target" src/api.ts --outfile="dist/effect-scrapling-api-${target}${ext}"',
    "Build workflow must compile the API SFE artifact.",
    errors,
  );
  collectMissingSnippet(
    content,
    `  release:
    needs: build
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' && inputs.publish_release == true`,
    "Release job must stay gated behind publish_release manual dispatches.",
    errors,
  );
  collectMissingSnippet(
    content,
    "needs: build",
    "Release job must depend on a successful build job.",
    errors,
  );
  collectMissingSnippet(
    content,
    "uses: softprops/action-gh-release@v2",
    "Release job must publish release artifacts through softprops/action-gh-release.",
    errors,
  );

  let parsedTargets: readonly string[] = [];
  try {
    parsedTargets = parseBuildTargets(content);
  } catch (error) {
    errors.push(Predicate.isError(error) ? error.message : "Unable to parse build target matrix.");
  }

  for (const requiredTarget of REQUIRED_BUILD_TARGETS) {
    if (!parsedTargets.includes(requiredTarget)) {
      errors.push(`Missing build target "${requiredTarget}" from the build matrix.`);
    }
  }

  return errors;
}

describe("CI affected gate workflow verification", () => {
  it("passes for the committed pr-affected-gates workflow", async () => {
    const workflow = await readWorkflow(PR_AFFECTED_GATES_WORKFLOW_PATH);
    expect(validatePrAffectedGatesWorkflow(workflow)).toEqual([]);
  });

  it("rejects the PR workflow when an affected gate is removed from the matrix", async () => {
    const workflow = await readWorkflow(PR_AFFECTED_GATES_WORKFLOW_PATH);
    const brokenWorkflow = replaceExactlyOnce(
      workflow,
      `          - name: affected-typecheck
            command: bun run nx affected -t typecheck --base="$NX_BASE" --head="$NX_HEAD" --parallel=1
`,
      "",
    );

    expect(validatePrAffectedGatesWorkflow(brokenWorkflow)).toContain(
      'Missing gate "affected-typecheck" from gate matrix.',
    );
  });

  it("rejects the PR workflow when aggregate status no longer fails on any non-success result", async () => {
    const workflow = await readWorkflow(PR_AFFECTED_GATES_WORKFLOW_PATH);
    const brokenWorkflow = replaceExactlyOnce(
      workflow,
      'if [[ "${{ needs.gate-matrix.result }}" != "success" ]]; then',
      'if [[ "${{ needs.gate-matrix.result }}" == "failure" ]]; then',
    );

    expect(validatePrAffectedGatesWorkflow(brokenWorkflow)).toContain(
      "Deterministic status job must fail unless the full gate matrix succeeds.",
    );
  });

  it("passes for the committed build-sfe workflow", async () => {
    const workflow = await readWorkflow(BUILD_SFE_WORKFLOW_PATH);
    expect(validateBuildSfeWorkflow(workflow)).toEqual([]);
  });

  it("rejects the build workflow when linux guardrail checks are weakened", async () => {
    const workflow = await readWorkflow(BUILD_SFE_WORKFLOW_PATH);
    const brokenWorkflow = replaceExactlyOnce(
      workflow,
      `      - name: Guardrails (lint, format, type-safety)
        if: matrix.target == 'bun-linux-x64'
        run: bun run check`,
      `      - name: Guardrails (lint, format, type-safety)
        if: matrix.target == 'bun-linux-x64'
        run: bun run ultracite`,
    );

    expect(validateBuildSfeWorkflow(brokenWorkflow)).toContain(
      "Linux x64 build job must execute the full guardrail check pipeline.",
    );
  });

  it("rejects the build workflow when release publishing is no longer strictly gated", async () => {
    const workflow = await readWorkflow(BUILD_SFE_WORKFLOW_PATH);
    const brokenWorkflow = replaceExactlyOnce(
      workflow,
      `  release:
    needs: build
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch' && inputs.publish_release == true`,
      `  release:
    needs: build
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'`,
    );

    expect(validateBuildSfeWorkflow(brokenWorkflow)).toContain(
      "Release job must stay gated behind publish_release manual dispatches.",
    );
  });

  it("ensures Nx projects expose test targets for the affected-test gate", async () => {
    const projectConfigs = await Promise.all(PROJECT_CONFIG_PATHS.map(readProjectConfig));

    for (const projectConfig of projectConfigs) {
      expect(projectConfig.name).toBeDefined();
      expect(projectConfig.targets?.test).toBeDefined();
      expect(projectConfig.targets?.test?.options?.command).toBeDefined();
    }
  });
});
