import { describe, expect, it, setDefaultTimeout } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  E9CapabilitySliceEvidenceSchema,
  E9LaunchReadinessArtifactSchema,
  E9ScraplingParityArtifactSchema,
} from "effect-scrapling/e9";
import { runE9SdkConsumerExample } from "../../examples/e9-sdk-consumer.ts";

setDefaultTimeout(120000);

describe("E9 SDK consumer example", () => {
  it("runs the public E9 consumer contract without private import leakage", async () => {
    const result = await Effect.runPromise(runE9SdkConsumerExample());
    const capabilitySlice = Schema.decodeUnknownSync(E9CapabilitySliceEvidenceSchema)(
      result.payload.capabilitySlice,
    );
    const parity = Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)(result.payload.parity);
    const readiness = Schema.decodeUnknownSync(E9LaunchReadinessArtifactSchema)(
      result.payload.readiness,
    );

    expect(result.importPath).toBe("effect-scrapling/e9");
    expect(result.pitfalls[0]).toContain("fixture-corpus postcapture");
    expect(capabilitySlice.launchReadiness.status).toBe("pass");
    expect(parity.caseCount).toBe(10);
    expect(readiness.status).toBe("pass");
  });

  it("keeps the example on the public E9 package import path only", async () => {
    const source = await Bun.file("examples/e9-sdk-consumer.ts").text();
    const importSpecifiers = [...source.matchAll(/from\s+"([^"]+)"/gu)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );

    expect(importSpecifiers).toEqual(["effect", "effect-scrapling/e9"]);
    expect(source.includes("../src/")).toBe(false);
    expect(source.includes("../scripts/")).toBe(false);
    expect(source.includes("../libs/")).toBe(false);
  });
});
