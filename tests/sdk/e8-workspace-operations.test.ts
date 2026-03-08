import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  WorkspaceConfigShowEnvelopeSchema,
  WorkspaceDoctorEnvelopeSchema,
  runWorkspaceDoctor,
  showWorkspaceConfig,
} from "effect-scrapling/e8";
import { handleApiRequest } from "../../src/api.ts";
import { executeCli } from "../../src/standalone.ts";

describe("E8 workspace operations", () => {
  it.effect("keeps the doctor envelope identical across SDK, CLI, and API", () =>
    Effect.gen(function* () {
      const sdkPayload = yield* runWorkspaceDoctor();
      const cliResult = yield* Effect.promise(() => executeCli(["workspace", "doctor"]));
      const apiPayload = yield* Effect.promise(async () =>
        handleApiRequest(new Request("http://localhost/doctor")).then((response) =>
          response.json(),
        ),
      );

      const decodedSdk = Schema.decodeUnknownSync(WorkspaceDoctorEnvelopeSchema)(sdkPayload);
      const decodedCli = Schema.decodeUnknownSync(WorkspaceDoctorEnvelopeSchema)(
        JSON.parse(cliResult.output),
      );
      const decodedApi = Schema.decodeUnknownSync(WorkspaceDoctorEnvelopeSchema)(apiPayload);

      expect(decodedSdk).toEqual(decodedCli);
      expect(decodedSdk).toEqual(decodedApi);
      expect(decodedSdk.command).toBe("doctor");
      expect(decodedSdk.ok).toBe(true);
    }),
  );

  it.effect("shows deterministic workspace config through the public E8 SDK and CLI", () =>
    Effect.gen(function* () {
      const sdkPayload = yield* showWorkspaceConfig();
      const cliResult = yield* Effect.promise(() => executeCli(["workspace", "config", "show"]));

      const decodedSdk = Schema.decodeUnknownSync(WorkspaceConfigShowEnvelopeSchema)(sdkPayload);
      const decodedCli = Schema.decodeUnknownSync(WorkspaceConfigShowEnvelopeSchema)(
        JSON.parse(cliResult.output),
      );

      expect(decodedSdk).toEqual(decodedCli);
      expect(decodedSdk.command).toBe("config show");
      expect(decodedSdk.data.package).toEqual({
        name: "effect-scrapling",
        version: "0.0.1",
      });
      expect(decodedSdk.data.browserPool).toEqual({
        maxContexts: 2,
        maxPages: 2,
        maxQueue: 8,
      });
      expect(decodedSdk.data.sourceOrder).toEqual(["defaults", "sitePack", "targetProfile", "run"]);
      expect(decodedSdk.data.runConfigDefaults.entryUrl).toBe(
        "https://example.com/workspace/default",
      );
      expect(decodedSdk.data.runConfigDefaults.checkpointInterval).toBe(3);
    }),
  );
});
