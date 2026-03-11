import { Effect, Layer, ServiceMap } from "effect";
import {
  type AccessHealthPolicy,
  type AccessHealthSnapshot,
  type AccessHealthSubject,
  AccessPathQuarantined,
  makeInMemoryAccessHealthRuntime,
} from "@effect-scrapling/foundation-core/access-health-runtime";
import { PolicyViolation } from "@effect-scrapling/foundation-core/tagged-errors";

export type AccessHealthRuntimeService = {
  readonly assertHealthy: (
    subjectInput: AccessHealthSubject,
  ) => Effect.Effect<AccessHealthSnapshot, PolicyViolation | AccessPathQuarantined, never>;
  readonly recordSuccess: (
    subjectInput: AccessHealthSubject,
    policyInput: AccessHealthPolicy,
  ) => Effect.Effect<AccessHealthSnapshot, PolicyViolation, never>;
  readonly recordFailure: (
    subjectInput: AccessHealthSubject,
    policyInput: AccessHealthPolicy,
    reason: string,
  ) => Effect.Effect<AccessHealthSnapshot, PolicyViolation, never>;
  readonly inspect: (
    subjectInput: AccessHealthSubject,
  ) => Effect.Effect<AccessHealthSnapshot, PolicyViolation, never>;
};

export class AccessHealthRuntime extends ServiceMap.Service<
  AccessHealthRuntime,
  AccessHealthRuntimeService
>()("@effect-scrapling/sdk/AccessHealthRuntime") {}

export const AccessHealthRuntimeLive = Layer.effect(
  AccessHealthRuntime,
  makeInMemoryAccessHealthRuntime(),
);
