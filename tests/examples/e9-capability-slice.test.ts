import { fileURLToPath } from "node:url";
import { describe, expect, it, setDefaultTimeout } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  E9CapabilitySliceEvidenceSchema,
  runE9CapabilitySliceExample,
  runE9CapabilitySliceExampleEncoded,
} from "../../examples/e9-capability-slice.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const exampleEntry = fileURLToPath(
  new URL("../../examples/e9-capability-slice.ts", import.meta.url),
);

setDefaultTimeout(20_000);

describe("examples/e9-capability-slice", () => {
  it("executes the E9 capability slice with linked evidence", async () => {
    const evidence = await runE9CapabilitySliceExample();
    const encoded = Schema.encodeSync(E9CapabilitySliceEvidenceSchema)(evidence);

    expect(encoded.evidencePath.validationId).toBe(encoded.referencePackValidation.validationId);
    expect(encoded.evidencePath.comparisonId).toBe(encoded.scraplingParity.comparisonId);
    expect(encoded.evidencePath.canarySuiteId).toBe(encoded.highFrictionCanary.suiteId);
    expect(encoded.evidencePath.readinessId).toBe(encoded.launchReadiness.readinessId);
    expect(encoded.referencePackValidation.status).toBe("pass");
    expect(encoded.scraplingParity.status).toBe("pass");
    expect(encoded.highFrictionCanary.status).toBe("pass");
    expect(encoded.launchReadiness.status).toBe("pass");
    expect(encoded.scraplingParity.caseCount).toBe(10);
    expect(encoded.highFrictionCanary.summary.scenarioCount).toBe(10);
    expect(encoded.launchReadiness.missingItems).toEqual([]);
  });

  it("runs standalone and emits schema-valid E9 evidence JSON", async () => {
    const expected = await runE9CapabilitySliceExampleEncoded();
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", exampleEntry],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr).trim()).toBe("");

    const stdout = new TextDecoder().decode(result.stdout);
    const actual = Schema.encodeSync(E9CapabilitySliceEvidenceSchema)(
      Schema.decodeUnknownSync(E9CapabilitySliceEvidenceSchema)(JSON.parse(stdout)),
    );

    expect(actual.evidencePath).toEqual(expected.evidencePath);
  });
});
