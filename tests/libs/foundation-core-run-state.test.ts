import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  ArtifactKindSchema,
  ArtifactRefSchema,
  ArtifactVisibilitySchema,
  CheckpointCorruption,
  ConcurrencyBudgetSchema,
  CoreErrorCodeSchema,
  DriftDetected,
  EgressLeaseSchema,
  ExtractionMismatch,
  IdentityLeaseSchema,
  ParserFailure,
  PolicyViolation,
  ProviderUnavailable,
  RenderCrashError,
  TimeoutError,
  toCoreErrorEnvelope,
} from "../../libs/foundation/core/src";

describe("foundation-core run state", () => {
  it("roundtrips budget, lease, and artifact references through public schema contracts", () => {
    expect(
      Schema.encodeSync(ConcurrencyBudgetSchema)(
        Schema.decodeUnknownSync(ConcurrencyBudgetSchema)({
          id: "budget-run-001",
          ownerId: "run-001",
          globalConcurrency: 120,
          maxPerDomain: 8,
        }),
      ),
    ).toEqual({
      id: "budget-run-001",
      ownerId: "run-001",
      globalConcurrency: 120,
      maxPerDomain: 8,
    });

    expect(
      Schema.encodeSync(EgressLeaseSchema)(
        Schema.decodeUnknownSync(EgressLeaseSchema)({
          id: "egress-lease-001",
          ownerId: "run-001",
          egressKey: "egress-pool-primary",
          expiresAt: "2026-03-06T00:05:00.000Z",
        }),
      ),
    ).toEqual({
      id: "egress-lease-001",
      ownerId: "run-001",
      egressKey: "egress-pool-primary",
      expiresAt: "2026-03-06T00:05:00.000Z",
    });

    expect(
      Schema.encodeSync(IdentityLeaseSchema)(
        Schema.decodeUnknownSync(IdentityLeaseSchema)({
          id: "identity-lease-001",
          ownerId: "run-001",
          identityKey: "identity-browser-eu-1",
          expiresAt: "2026-03-06T00:05:00.000Z",
        }),
      ),
    ).toEqual({
      id: "identity-lease-001",
      ownerId: "run-001",
      identityKey: "identity-browser-eu-1",
      expiresAt: "2026-03-06T00:05:00.000Z",
    });

    expect(
      Schema.encodeSync(ArtifactRefSchema)(
        Schema.decodeUnknownSync(ArtifactRefSchema)({
          id: "artifact-html-001",
          ownerId: "run-001",
          runId: "run-001",
          kind: "html",
          visibility: "redacted",
          locator: ".sf/artifacts/run-001/page.html",
        }),
      ),
    ).toEqual({
      id: "artifact-html-001",
      ownerId: "run-001",
      runId: "run-001",
      kind: "html",
      visibility: "redacted",
      locator: ".sf/artifacts/run-001/page.html",
    });

    expect(Schema.decodeUnknownSync(ArtifactKindSchema)("screenshot")).toBe("screenshot");
    expect(Schema.decodeUnknownSync(ArtifactVisibilitySchema)("raw")).toBe("raw");
  });

  it("rejects invalid budget bounds, missing lease ownership, and malformed artifact refs", () => {
    expect(() =>
      Schema.decodeUnknownSync(ConcurrencyBudgetSchema)({
        id: "budget-run-001",
        ownerId: "run-001",
        globalConcurrency: 4,
        maxPerDomain: 8,
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(EgressLeaseSchema)({
        id: "egress-lease-001",
        ownerId: "",
        egressKey: "egress-pool-primary",
        expiresAt: "2026-03-06T00:05:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(IdentityLeaseSchema)({
        id: "identity-lease-001",
        identityKey: "identity-browser-eu-1",
        expiresAt: "2026-03-06T00:05:00.000Z",
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(ArtifactRefSchema)({
        id: "artifact-html-001",
        ownerId: "run-001",
        runId: "run-001",
        kind: "archive",
        visibility: "redacted",
        locator: ".sf/artifacts/run-001/page.html",
      }),
    ).toThrow();

    expect(() =>
      Schema.decodeUnknownSync(EgressLeaseSchema)({
        id: "egress-lease-001",
        ownerId: "run-001",
        egressKey: "egress-pool-primary",
        expiresAt: "2026-02-30T00:05:00.000Z",
      }),
    ).toThrow();
  });
});

describe("foundation-core tagged errors", () => {
  it("maps tagged errors to stable machine-readable envelopes without manual tag inspection", () => {
    expect(
      toCoreErrorEnvelope(new TimeoutError({ message: "Timed out waiting for response" })),
    ).toEqual({
      code: "timeout",
      retryable: true,
      message: "Timed out waiting for response",
    });

    expect(
      toCoreErrorEnvelope(new RenderCrashError({ message: "Renderer exited unexpectedly" })),
    ).toEqual({
      code: "render_crash",
      retryable: true,
      message: "Renderer exited unexpectedly",
    });

    expect(toCoreErrorEnvelope(new ParserFailure({ message: "Selector parse failed" }))).toEqual({
      code: "parser_failure",
      retryable: false,
      message: "Selector parse failed",
    });

    expect(
      toCoreErrorEnvelope(new ExtractionMismatch({ message: "Required field extraction drifted" })),
    ).toEqual({
      code: "extraction_mismatch",
      retryable: false,
      message: "Required field extraction drifted",
    });

    expect(
      toCoreErrorEnvelope(
        new DriftDetected({ message: "Pack confidence dropped below threshold" }),
      ),
    ).toEqual({
      code: "drift_detected",
      retryable: false,
      message: "Pack confidence dropped below threshold",
    });

    expect(
      toCoreErrorEnvelope(
        new CheckpointCorruption({ message: "Checkpoint payload failed integrity validation" }),
      ),
    ).toEqual({
      code: "checkpoint_corruption",
      retryable: false,
      message: "Checkpoint payload failed integrity validation",
    });

    expect(
      toCoreErrorEnvelope(new PolicyViolation({ message: "Execution policy denied access" })),
    ).toEqual({
      code: "policy_violation",
      retryable: false,
      message: "Execution policy denied access",
    });

    expect(
      toCoreErrorEnvelope(new ProviderUnavailable({ message: "Fallback provider unavailable" })),
    ).toEqual({
      code: "provider_unavailable",
      retryable: true,
      message: "Fallback provider unavailable",
    });

    expect(Schema.decodeUnknownSync(CoreErrorCodeSchema)("timeout")).toBe("timeout");
    expect(Schema.decodeUnknownSync(CoreErrorCodeSchema)("policy_violation")).toBe(
      "policy_violation",
    );
    expect(() => Schema.decodeUnknownSync(CoreErrorCodeSchema)("opaque_failure")).toThrow();
  });
});
