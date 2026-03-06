import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E3CapabilitySliceEvidenceSchema,
  runE3CapabilitySlice,
  runE3CapabilitySliceEncoded,
} from "../../examples/e3-capability-slice.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const exampleEntry = fileURLToPath(
  new URL("../../examples/e3-capability-slice.ts", import.meta.url),
);

describe("examples/e3-capability-slice", () => {
  it.effect("executes the deterministic E3 capability slice in-process with typed evidence", () =>
    Effect.gen(function* () {
      const evidence = yield* runE3CapabilitySlice();
      const encoded = Schema.encodeSync(E3CapabilitySliceEvidenceSchema)(evidence);

      expect(encoded.plannerDecision.plan).toEqual(encoded.servicePlan);
      expect(encoded.plannerDecision.rationale.map(({ key }) => key)).toEqual([
        "mode",
        "rendering",
        "budget",
        "capture-path",
      ]);

      expect(encoded.budgetEvents.map(({ kind }) => kind)).toEqual(["acquired", "released"]);
      expect(encoded.budgetBefore.globalInUse).toBe(0);
      expect(encoded.budgetAfter.globalInUse).toBe(0);
      expect(encoded.budgetAfter.domains[0]?.domain).toBe("example.com");

      expect(encoded.identityScopeDuringRun.activeLeaseIds).toEqual([encoded.identityLease.id]);
      expect(encoded.identityScopeAfterRun.activeLeaseCount).toBe(0);
      expect(encoded.identityEvents.map(({ kind }) => kind)).toEqual(["allocated", "released"]);

      expect(encoded.egressScopeDuringRun.activeLeaseIds).toEqual([encoded.egressLease.id]);
      expect(encoded.egressScopeAfterRun.activePoolLeaseCount).toBe(0);
      expect(encoded.egressEvents.map(({ kind }) => kind)).toEqual(["allocated", "released"]);

      expect(encoded.captureBundle.artifacts).toEqual(encoded.serviceArtifacts);
      expect(encoded.storedCapture).toEqual(encoded.reloadedCapture);
      expect(encoded.captureBundle.payloads[2]?.body).toContain("<h1>Example Product</h1>");
      expect(encoded.captureBundle.payloads[3]?.body).toContain('"durationMs": 12.5');

      expect(encoded.domainHealth.successCount).toBe(1);
      expect(encoded.providerHealth.successCount).toBe(1);
      expect(encoded.identityHealth.successCount).toBe(1);
      expect(encoded.domainHealth.quarantinedUntil).toBeNull();
      expect(encoded.healthEvents.map(({ kind }) => kind)).toEqual([
        "success",
        "success",
        "success",
      ]);
    }),
  );

  it("runs standalone and emits the same typed evidence JSON", async () => {
    const expected = await Effect.runPromise(runE3CapabilitySliceEncoded());
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
    const decoded = Schema.decodeUnknownSync(E3CapabilitySliceEvidenceSchema)(JSON.parse(stdout));
    const actual = Schema.encodeSync(E3CapabilitySliceEvidenceSchema)(decoded);

    expect(actual).toEqual(expected);
  });
});
