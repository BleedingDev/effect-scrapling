import { Effect, Layer, Schema } from "effect";
import { PackPromotionDecisionSchema, QualityVerdictSchema } from "./diff-verdict.ts";
import { ReflectionEngine } from "./service-topology.ts";
import { SitePackSchema } from "./site-pack.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const PackPromotionAutomationInputSchema = Schema.Struct({
  pack: SitePackSchema,
  verdict: QualityVerdictSchema,
});

const criticalGateNames: ReadonlySet<string> = new Set([
  "workflowResume",
  "securityRedaction",
  "soakStability",
]);

type PackPromotionAutomationInput = Schema.Schema.Type<typeof PackPromotionAutomationInputSchema>;
type QualityVerdict = Schema.Schema.Type<typeof QualityVerdictSchema>;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function failedGates(verdict: QualityVerdict) {
  return verdict.gates.filter(({ status }) => status === "fail");
}

function criticalFailures(verdict: QualityVerdict) {
  return failedGates(verdict).filter(({ name }) => criticalGateNames.has(name));
}

function transitionTarget(action: QualityVerdict["action"]) {
  switch (action) {
    case "promote-shadow":
      return "shadow";
    case "active":
      return "active";
    case "guarded":
      return "guarded";
    case "quarantined":
      return "quarantined";
    case "retired":
      return "retired";
  }
}

function ensureVerdictMatchesPack(input: PackPromotionAutomationInput) {
  if (input.verdict.packId !== input.pack.id) {
    return Effect.fail(
      new PolicyViolation({
        message: "Expected the quality verdict pack id to match the selected site pack.",
      }),
    );
  }

  return Effect.void;
}

function ensureVerdictConsistency(input: PackPromotionAutomationInput) {
  const failed = failedGates(input.verdict);
  const critical = criticalFailures(input.verdict);

  switch (input.verdict.action) {
    case "promote-shadow":
    case "active": {
      if (failed.length > 0) {
        return Effect.fail(
          new PolicyViolation({
            message:
              "Expected promote-shadow and active automation to run only after every validator gate passes.",
          }),
        );
      }

      return Effect.void;
    }
    case "guarded": {
      if (failed.length === 0) {
        return Effect.fail(
          new PolicyViolation({
            message: "Expected guarded automation to retain at least one failing validator gate.",
          }),
        );
      }

      if (critical.length > 0) {
        return Effect.fail(
          new PolicyViolation({
            message:
              "Expected guarded automation to be reserved for non-critical validator failures.",
          }),
        );
      }

      return Effect.void;
    }
    case "quarantined": {
      if (critical.length === 0) {
        return Effect.fail(
          new PolicyViolation({
            message:
              "Expected quarantined automation to include at least one critical validator failure.",
          }),
        );
      }

      return Effect.void;
    }
    case "retired": {
      if (failed.length === 0) {
        return Effect.fail(
          new PolicyViolation({
            message: "Expected retired automation to include failing validator gates.",
          }),
        );
      }

      return Effect.void;
    }
  }
}

function buildDecision(input: PackPromotionAutomationInput) {
  return Effect.try({
    try: () =>
      Schema.decodeUnknownSync(PackPromotionDecisionSchema)({
        id: `promotion-${input.pack.id}-${input.verdict.action}-${input.verdict.snapshotDiffId}`,
        packId: input.pack.id,
        sourceVersion: input.pack.version,
        triggerVerdictId: input.verdict.id,
        createdAt: input.verdict.createdAt,
        fromState: input.pack.state,
        toState: transitionTarget(input.verdict.action),
        action: input.verdict.action,
      }),
    catch: (cause) =>
      new PolicyViolation({
        message:
          `${`Expected validator action ${input.verdict.action} to be valid for pack state ${input.pack.state}.`} ${readCauseMessage(cause, "")}`.trim(),
      }),
  });
}

export function decidePackPromotion(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PackPromotionAutomationInputSchema)(input),
      catch: (cause) =>
        new PolicyViolation({
          message: readCauseMessage(
            cause,
            "Failed to decode reflection-engine automation input through shared contracts.",
          ),
        }),
    });

    yield* ensureVerdictMatchesPack(decoded);
    yield* ensureVerdictConsistency(decoded);

    return yield* buildDecision(decoded);
  });
}

export function makeReflectionEngine() {
  return ReflectionEngine.of({
    decide: (pack, verdict) =>
      decidePackPromotion({ pack, verdict }).pipe(
        Effect.map((decision) => Schema.encodeSync(PackPromotionDecisionSchema)(decision)),
      ),
  });
}

export const ReflectionEngineLive = Layer.succeed(ReflectionEngine)(makeReflectionEngine());
