import { describe, expect, it } from "@effect-native/bun-test";
import {
  CheckpointCorruption,
  DriftDetected,
  ExtractionMismatch,
  ParserFailure,
  PolicyViolation,
  ProviderUnavailable,
  RenderCrashError,
  TimeoutError,
  toCoreErrorEnvelope,
} from "../../libs/foundation/core/src";

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
  });
});
