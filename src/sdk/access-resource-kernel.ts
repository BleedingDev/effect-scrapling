import { Effect, Exit, Layer, ServiceMap } from "effect";
import { EgressBroker, IdentityBroker } from "./access-broker-runtime.ts";
import {
  materializeExecutionContext,
  type AccessExecutionContext,
  type ResolvedExecutionIntent,
} from "./access-runtime.ts";
import {
  AccessQuarantinedError,
  AccessResourceError,
  BrowserError,
  InvalidInputError,
  NetworkError,
} from "./errors.ts";

export type ProvisionedAccessPath = {
  readonly context: AccessExecutionContext;
  readonly release: Effect.Effect<void, never, never>;
};

export class AccessResourceKernel extends ServiceMap.Service<
  AccessResourceKernel,
  {
    readonly provision: (input: {
      readonly url: string;
      readonly intent: ResolvedExecutionIntent;
    }) => Effect.Effect<
      ProvisionedAccessPath,
      | InvalidInputError
      | AccessResourceError
      | AccessQuarantinedError
      | NetworkError
      | BrowserError,
      never
    >;
  }
>()("@effect-scrapling/sdk/AccessResourceKernel") {}

export const AccessResourceKernelLive = Layer.effect(
  AccessResourceKernel,
  Effect.gen(function* () {
    const egressBroker = yield* EgressBroker;
    const identityBroker = yield* IdentityBroker;

    return {
      provision: ({ url, intent }) =>
        Effect.gen(function* () {
          const egress = yield* egressBroker.acquire({ url, plan: intent });
          const acquiredIdentity = yield* identityBroker
            .acquire({ url, plan: intent })
            .pipe(Effect.exit);

          if (Exit.isFailure(acquiredIdentity)) {
            yield* egress.release;
            return yield* Effect.failCause(acquiredIdentity.cause);
          }

          const identity = acquiredIdentity.value;
          const context = materializeExecutionContext({
            intent,
            egress,
            identity,
          });

          return {
            context,
            release: Effect.all([identity.release, egress.release], {
              concurrency: "unbounded",
              discard: true,
            }),
          } satisfies ProvisionedAccessPath;
        }),
    } satisfies AccessResourceKernel["Service"];
  }),
);
