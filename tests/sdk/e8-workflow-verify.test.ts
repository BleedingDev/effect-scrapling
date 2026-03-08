import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  CrawlCompileEnvelopeSchema,
  WorkflowInspectEnvelopeSchema,
  WorkflowRunEnvelopeSchema,
  runCrawlCompileOperation,
  runWorkflowInspectOperation,
  runWorkflowResumeOperation,
  runWorkflowRunOperation,
} from "effect-scrapling/e8";
import { executeCli } from "../../src/standalone.ts";
import { InvalidInputError } from "../../src/sdk/errors.ts";

function makeTarget() {
  return {
    id: "target-workflow-001",
    tenantId: "tenant-main",
    domain: "shop.example.com",
    kind: "productPage",
    canonicalKey: "productPage/target-workflow-001",
    seedUrls: ["https://shop.example.com/target-workflow-001"],
    accessPolicyId: "policy-default",
    packId: "pack-shop-example-com",
    priority: 50,
  };
}

function makePack() {
  return {
    id: "pack-shop-example-com",
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state: "shadow",
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  };
}

function makeAccessPolicy() {
  return {
    id: "policy-default",
    mode: "http",
    render: "never",
    perDomainConcurrency: 2,
    globalConcurrency: 8,
    timeoutMs: 30_000,
    maxRetries: 1,
  };
}

describe("E8 workflow verification", () => {
  it.effect("keeps crawl compile and workflow inspection deterministic across SDK and CLI", () =>
    Effect.gen(function* () {
      const compileInput = {
        createdAt: "2026-03-09T13:00:00.000Z",
        entries: [
          {
            target: makeTarget(),
            pack: makePack(),
            accessPolicy: makeAccessPolicy(),
          },
        ],
      };

      const compiled = yield* runCrawlCompileOperation(compileInput);
      const workflowRun = yield* runWorkflowRunOperation({
        compiledPlan: compiled.data.compiled,
        pack: makePack(),
      });
      const workflowResume = yield* runWorkflowResumeOperation({
        compiledPlan: compiled.data.compiled,
        checkpoint: workflowRun.data.checkpoint,
        pack: makePack(),
      });
      const workflowInspect = yield* runWorkflowInspectOperation({
        compiledPlan: compiled.data.compiled,
        checkpoint: workflowResume.data.checkpoint,
        pack: makePack(),
      });
      const cliCompile = yield* Effect.promise(() =>
        executeCli(["crawl", "compile", "--input", JSON.stringify(compileInput)]),
      );
      const cliRun = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "run",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            pack: makePack(),
          }),
        ]),
      );
      const cliInspect = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "inspect",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            checkpoint: workflowResume.data.checkpoint,
            pack: makePack(),
          }),
        ]),
      );

      expect(Schema.decodeUnknownSync(CrawlCompileEnvelopeSchema)(compiled)).toEqual(
        Schema.decodeUnknownSync(CrawlCompileEnvelopeSchema)(JSON.parse(cliCompile.output)),
      );
      expect(Schema.decodeUnknownSync(WorkflowRunEnvelopeSchema)(workflowRun)).toEqual(
        Schema.decodeUnknownSync(WorkflowRunEnvelopeSchema)(JSON.parse(cliRun.output)),
      );
      expect(Schema.decodeUnknownSync(WorkflowInspectEnvelopeSchema)(workflowInspect)).toEqual(
        Schema.decodeUnknownSync(WorkflowInspectEnvelopeSchema)(JSON.parse(cliInspect.output)),
      );
      expect(workflowRun.data.checkpoint.runId).toBe(compiled.data.compiled.plan.id);
      expect(workflowResume.data.checkpoint.runId).toBe(compiled.data.compiled.plan.id);
      expect(workflowInspect.data.inspection.runId).toBe(compiled.data.compiled.plan.id);
      expect(workflowInspect.data.inspection.nextStepId).toBe("step-extract");
      expect(workflowInspect.data.inspection.progress.pendingStepIds).toContain("step-extract");
    }),
  );

  it.effect("rejects malformed workflow lineage across SDK and CLI", () =>
    Effect.gen(function* () {
      const compiled = yield* runCrawlCompileOperation({
        createdAt: "2026-03-09T13:00:00.000Z",
        entries: [
          {
            target: makeTarget(),
            pack: makePack(),
            accessPolicy: makeAccessPolicy(),
          },
        ],
      });
      const workflowRun = yield* runWorkflowRunOperation({
        compiledPlan: compiled.data.compiled,
        pack: makePack(),
      });
      const invalidInspectInput = {
        compiledPlan: compiled.data.compiled,
        checkpoint: {
          ...workflowRun.data.checkpoint,
          runId: "plan-other",
        },
        pack: makePack(),
      };
      const invalidSdkError = yield* Effect.flip(runWorkflowInspectOperation(invalidInspectInput));
      const invalidCli = yield* Effect.promise(() =>
        executeCli(["workflow", "inspect", "--input", JSON.stringify(invalidInspectInput)]),
      );
      const invalidResumeCli = yield* Effect.promise(() =>
        executeCli([
          "workflow",
          "resume",
          "--input",
          JSON.stringify({
            compiledPlan: compiled.data.compiled,
            checkpoint: {
              ...workflowRun.data.checkpoint,
              resumeToken: "not-a-resume-token",
            },
            pack: makePack(),
          }),
        ]),
      );

      expect(invalidSdkError).toBeInstanceOf(InvalidInputError);
      expect(invalidSdkError.message).toContain("Invalid workflow inspect payload.");
      expect(invalidCli.exitCode).toBe(2);
      expect(JSON.parse(invalidCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
      expect(invalidResumeCli.exitCode).toBe(2);
      expect(JSON.parse(invalidResumeCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
    }),
  );
});
