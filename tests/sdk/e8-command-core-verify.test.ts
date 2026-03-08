import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  WorkspaceConfigShowEnvelopeSchema,
  WorkspaceDoctorEnvelopeSchema,
  executeWorkspaceCommand,
  runWorkspaceDoctor,
  showWorkspaceConfig,
} from "effect-scrapling/e8";
import { executeCli } from "../../src/standalone.ts";

describe("E8 shared command handler core verification", () => {
  it.effect("routes doctor and config-show through one deterministic shared E8 core", () =>
    Effect.gen(function* () {
      const doctorFromCore = yield* executeWorkspaceCommand("doctor");
      const doctorDirect = yield* runWorkspaceDoctor();
      const configFromCore = yield* executeWorkspaceCommand("config-show");
      const configDirect = yield* showWorkspaceConfig();

      expect(Schema.decodeUnknownSync(WorkspaceDoctorEnvelopeSchema)(doctorFromCore)).toEqual(
        Schema.decodeUnknownSync(WorkspaceDoctorEnvelopeSchema)(doctorDirect),
      );
      expect(Schema.decodeUnknownSync(WorkspaceConfigShowEnvelopeSchema)(configFromCore)).toEqual(
        Schema.decodeUnknownSync(WorkspaceConfigShowEnvelopeSchema)(configDirect),
      );
    }),
  );

  it("rejects unsupported workspace subcommands through the CLI boundary", async () => {
    const result = await executeCli(["workspace", "config", "print"]);
    const payload = JSON.parse(result.output);

    expect(result.exitCode).toBe(2);
    expect(payload).toMatchObject({
      ok: false,
      code: "InvalidInputError",
    });
    expect(String(payload.message)).toContain("Unknown command: workspace config print");
  });
});
