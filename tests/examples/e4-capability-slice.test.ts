import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Logger, Schema } from "effect";
import {
  E4CapabilitySliceEvidenceSchema,
  runE4CapabilitySlice,
  runE4CapabilitySliceEncoded,
} from "../../examples/e4-capability-slice.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const exampleEntry = fileURLToPath(
  new URL("../../examples/e4-capability-slice.ts", import.meta.url),
);

describe("examples/e4-capability-slice", () => {
  it.effect("executes the deterministic E4 capability slice in-process with typed evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* runE4CapabilitySlice().pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set<Logger.Logger<unknown, unknown>>()),
      );
      const encoded = Schema.encodeSync(E4CapabilitySliceEvidenceSchema)(evidence);
      const renderedDomExport = encoded.redactedExports.exports.find(
        ({ kind }) => kind === "renderedDom",
      );
      const networkSummaryExport = encoded.redactedExports.exports.find(
        ({ kind }) => kind === "networkSummary",
      );

      expect(encoded.plannerDecision.plan).toEqual(encoded.servicePlan);
      expect(encoded.plannerDecision.plan.steps[0]?.requiresBrowser).toBe(true);
      expect(encoded.plannerDecision.rationale.map(({ key }) => key)).toEqual([
        "mode",
        "rendering",
        "budget",
        "capture-path",
      ]);
      expect(
        encoded.plannerDecision.rationale.find(({ key }) => key === "capture-path")?.message,
      ).toContain("high-friction searchResult targets");

      expect(encoded.rawCaptureBundle.artifacts.map(({ kind }) => kind)).toEqual([
        "renderedDom",
        "screenshot",
        "networkSummary",
        "timings",
      ]);
      expect(
        encoded.serviceArtifacts.map(({ kind, locator, mediaType, visibility }) => ({
          kind,
          locator,
          mediaType,
          visibility,
        })),
      ).toEqual(
        encoded.rawCaptureBundle.artifacts.map(({ kind, locator, mediaType, visibility }) => ({
          kind,
          locator,
          mediaType,
          visibility,
        })),
      );
      expect(encoded.redactedExports.exports.map(({ kind }) => kind)).toEqual([
        "renderedDom",
        "screenshot",
        "networkSummary",
        "timings",
      ]);

      expect(renderedDomExport?.body).toContain('"hiddenFieldCount": 1');
      expect(renderedDomExport?.body).toContain("[REDACTED]");
      expect(renderedDomExport?.body).not.toContain("browser-secret");
      expect(renderedDomExport?.body).not.toContain("super-secret");

      expect(networkSummaryExport?.body).toContain("%5BREDACTED%5D");
      expect(networkSummaryExport?.body).not.toContain("browser-secret");

      expect(encoded.policyDecisions.map(({ policy, outcome }) => `${policy}:${outcome}`)).toEqual([
        "sessionIsolation:allowed",
        "sessionIsolation:allowed",
        "originRestriction:allowed",
        "sessionIsolation:allowed",
        "sessionIsolation:allowed",
        "originRestriction:allowed",
      ]);
      expect(encoded.leakSnapshot.openBrowsers).toBe(0);
      expect(encoded.leakSnapshot.openContexts).toBe(0);
      expect(encoded.leakSnapshot.openPages).toBe(0);
      expect(encoded.leakAlarms).toEqual([]);
      expect(encoded.crashTelemetry).toEqual([]);
      expect(encoded.lifecycle).toEqual({
        launches: 2,
        browserCloses: 2,
        contextCloses: 2,
        pageCloses: 2,
      });
    }),
  );

  it("runs standalone and emits the same typed evidence JSON", async () => {
    const expected = await Effect.runPromise(
      runE4CapabilitySliceEncoded().pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set<Logger.Logger<unknown, unknown>>()),
      ),
    );
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", exampleEntry],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = new TextDecoder().decode(result.stderr).trim();
    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");

    const stdout = new TextDecoder().decode(result.stdout);
    const decoded = Schema.decodeUnknownSync(E4CapabilitySliceEvidenceSchema)(JSON.parse(stdout));
    const actual = Schema.encodeSync(E4CapabilitySliceEvidenceSchema)(decoded);

    expect(actual).toEqual(expected);
  });
});
