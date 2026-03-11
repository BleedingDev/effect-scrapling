import { Effect, Exit, Layer, ServiceMap } from "effect";
import { type AccessHealthSnapshot } from "@effect-scrapling/foundation-core/access-health-runtime";
import { AccessHealthRuntime } from "./access-health-runtime-service.ts";
import { type AccessProviderId } from "./schemas.ts";

const INVALID_SELECTION_DOMAIN = "invalid-selection-target.local";

export type AccessSelectionHealthInput = {
  readonly url: string;
  readonly providerIds: ReadonlyArray<AccessProviderId>;
};

export type AccessSelectionHealthSignals = {
  readonly domain: AccessHealthSnapshot;
  readonly providers: Readonly<Record<string, AccessHealthSnapshot>>;
};

function domainFromUrl(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return INVALID_SELECTION_DOMAIN;
  }
}

function isCanonicalProviderId(providerId: AccessProviderId) {
  return !/\s/gu.test(providerId);
}

export class AccessSelectionHealthSignalsGateway extends ServiceMap.Service<
  AccessSelectionHealthSignalsGateway,
  {
    readonly inspect: (
      input: AccessSelectionHealthInput,
    ) => Effect.Effect<AccessSelectionHealthSignals, never, never>;
  }
>()("@effect-scrapling/sdk/AccessSelectionHealthSignalsGateway") {}

export const AccessSelectionHealthSignalsGatewayLive = Layer.effect(
  AccessSelectionHealthSignalsGateway,
  Effect.gen(function* () {
    const runtime = yield* AccessHealthRuntime;

    return {
      inspect: ({ url, providerIds }: AccessSelectionHealthInput) =>
        Effect.gen(function* () {
          const domain = domainFromUrl(url);
          const inspectedSignals = yield* Effect.exit(
            Effect.gen(function* () {
              const domainSnapshot = yield* runtime.inspect({
                kind: "domain",
                domain,
              });

              const providerSnapshots = yield* Effect.forEach(
                [...new Set(providerIds)].filter(isCanonicalProviderId),
                (providerId) =>
                  runtime
                    .inspect({
                      kind: "provider",
                      providerId,
                    })
                    .pipe(Effect.map((snapshot) => [providerId, snapshot] as const)),
                {
                  concurrency: "unbounded",
                },
              );

              const providers = Object.fromEntries(providerSnapshots) as Readonly<
                Record<string, AccessHealthSnapshot>
              >;

              return {
                domain: domainSnapshot,
                providers,
              } satisfies AccessSelectionHealthSignals;
            }),
          );

          if (Exit.isSuccess(inspectedSignals)) {
            return inspectedSignals.value;
          }

          return {
            domain: {
              subject: {
                kind: "domain",
                domain,
              },
              successCount: 0,
              failureCount: 0,
              successStreak: 0,
              failureStreak: 0,
              score: 100,
              quarantinedUntil: null,
            } satisfies AccessHealthSnapshot,
            providers: {} satisfies Readonly<Record<string, AccessHealthSnapshot>>,
          } satisfies AccessSelectionHealthSignals;
        }),
    } satisfies {
      readonly inspect: (
        input: AccessSelectionHealthInput,
      ) => Effect.Effect<AccessSelectionHealthSignals, never, never>;
    };
  }),
);
