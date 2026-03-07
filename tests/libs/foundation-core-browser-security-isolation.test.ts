import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Logger, Match, Schema } from "effect";
import {
  BrowserPolicyDecisionSchema,
  makeInMemoryBrowserAccessSecurityPolicy,
} from "../../libs/foundation/core/src/browser-access-policy.ts";
import {
  type BrowserAccessEngine,
  BrowserAccessLive,
} from "../../libs/foundation/core/src/browser-access-runtime.ts";
import { RunPlanSchema } from "../../libs/foundation/core/src/run-state.ts";
import { BrowserAccess } from "../../libs/foundation/core/src/service-topology.ts";

const browserPlan = Schema.decodeUnknownSync(RunPlanSchema)({
  id: "plan-browser-security-001",
  targetId: "target-product-001",
  packId: "pack-example-com",
  accessPolicyId: "policy-browser",
  concurrencyBudgetId: "budget-browser-001",
  entryUrl: "https://example.com/products/001",
  maxAttempts: 2,
  timeoutMs: 30_000,
  checkpointInterval: 2,
  steps: [
    {
      id: "step-capture-001",
      stage: "capture",
      requiresBrowser: true,
      artifactKind: "renderedDom",
    },
    {
      id: "step-extract-001",
      stage: "extract",
      requiresBrowser: false,
    },
  ],
  createdAt: "2026-03-06T10:00:00.000Z",
});

const encodePolicyDecision = Schema.encodeSync(BrowserPolicyDecisionSchema);
const BrowserPolicyDecisionLogSchema = Schema.Struct({
  event: Schema.Literal("browser.policy.decision"),
  planId: Schema.String,
  sessionId: Schema.String,
  policy: Schema.Literals(["sessionIsolation", "originRestriction"] as const),
  subject: Schema.Literals(["context", "page", "navigation"] as const),
  outcome: Schema.Literals(["allowed", "blocked"] as const),
  ownerSessionId: Schema.NullOr(Schema.String),
  expectedOrigin: Schema.NullOr(Schema.String),
  observedOrigin: Schema.NullOr(Schema.String),
  message: Schema.String,
  recordedAt: Schema.String,
});
const decodePolicyDecisionLog = Schema.decodeUnknownSync(BrowserPolicyDecisionLogSchema);

function capturePolicyDecisionLogs<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  readonly [A, ReadonlyArray<Schema.Schema.Type<typeof BrowserPolicyDecisionLogSchema>>],
  E,
  R
> {
  return Effect.gen(function* () {
    const entries: string[] = [];
    const logger: Logger.Logger<unknown, unknown> = Logger.make<unknown, unknown>(({ message }) => {
      const formattedMessage =
        typeof message === "string"
          ? message
          : Array.isArray(message) && message.every((entry) => typeof entry === "string")
            ? message.join("")
            : undefined;

      if (formattedMessage !== undefined) {
        entries.push(formattedMessage);
      }
    });
    const result = yield* effect.pipe(
      Effect.provideService(
        Logger.CurrentLoggers,
        new Set<Logger.Logger<unknown, unknown>>([logger]),
      ),
      Effect.provideService(Logger.LogToStderr, false),
    );
    const decisions = entries.flatMap((entry) => {
      try {
        const decoded = JSON.parse(entry);
        return Reflect.get(decoded, "event") === "browser.policy.decision"
          ? [decodePolicyDecisionLog(decoded)]
          : [];
      } catch {
        return [];
      }
    });

    return [result, decisions] as const;
  });
}

describe("foundation-core browser security isolation", () => {
  it.effect(
    "blocks reused browser contexts across capture sessions and recovers on a fresh browser generation",
    () =>
      Effect.gen(function* () {
        const policy = yield* makeInMemoryBrowserAccessSecurityPolicy({
          now: () => new Date("2026-03-06T10:00:05.000Z"),
        });
        const launches = { current: 0 };
        const newPageCalls = { current: 0 };
        const closed = {
          browsers: [] as string[],
          contexts: 0,
          pages: 0,
        };

        const sharedContext = {
          newPage: async () => {
            newPageCalls.current += 1;

            return {
              goto: async () => undefined,
              url: async () => "https://example.com/products/001",
              content: async () => "<html><body><main>shared-context</main></body></html>",
              screenshot: async () => Uint8Array.from([1, 2, 3]),
              evaluate: async () => ({
                navigation: [],
                resources: [],
              }),
              close: async () => {
                closed.pages += 1;
              },
            };
          },
          close: async () => {
            closed.contexts += 1;
          },
        };

        const engine: BrowserAccessEngine = {
          chromium: {
            launch: async () => {
              launches.current += 1;
              const browserId = `browser-${launches.current}`;

              return launches.current === 1
                ? {
                    newContext: async () => sharedContext,
                    close: async () => {
                      closed.browsers.push(browserId);
                    },
                  }
                : {
                    newContext: async () => ({
                      newPage: async () => {
                        newPageCalls.current += 1;

                        return {
                          goto: async () => undefined,
                          url: async () => "https://example.com/products/001",
                          content: async () =>
                            "<html><body><main>fresh-context</main></body></html>",
                          screenshot: async () => Uint8Array.from([4, 5, 6]),
                          evaluate: async () => ({
                            navigation: [],
                            resources: [],
                          }),
                          close: async () => {
                            closed.pages += 1;
                          },
                        };
                      },
                      close: async () => {
                        closed.contexts += 1;
                      },
                    }),
                    close: async () => {
                      closed.browsers.push(browserId);
                    },
                  };
            },
          },
        };

        const [[firstArtifacts, isolationFailure, recoveredArtifacts], loggedDecisions] =
          yield* capturePolicyDecisionLogs(
            Effect.scoped(
              Effect.gen(function* () {
                const access = yield* BrowserAccess;
                const firstCapture = yield* access.capture(browserPlan);
                const secondCaptureFailure = yield* access.capture(browserPlan).pipe(Effect.flip);
                const thirdCapture = yield* access.capture(browserPlan);
                return [firstCapture, secondCaptureFailure, thirdCapture] as const;
              }).pipe(
                Effect.provide(
                  BrowserAccessLive({
                    engine,
                    securityPolicy: policy,
                    now: () => new Date("2026-03-06T10:00:05.000Z"),
                  }),
                ),
              ),
            ),
          );
        const decisions = yield* policy.readDecisions;
        const isolationFailureMessage = Match.value(isolationFailure).pipe(
          Match.tag("PolicyViolation", ({ message }) => message),
          Match.tag("ProviderUnavailable", ({ message }) => message),
          Match.tag("RenderCrashError", ({ message }) => message),
          Match.tag("TimeoutError", ({ message }) => message),
          Match.exhaustive,
        );

        expect(firstArtifacts.map(({ kind }) => kind)).toEqual([
          "renderedDom",
          "screenshot",
          "networkSummary",
          "timings",
        ]);
        expect(isolationFailureMessage).toContain("Blocked context reuse across browser sessions");
        expect(recoveredArtifacts.map(({ kind }) => kind)).toEqual([
          "renderedDom",
          "screenshot",
          "networkSummary",
          "timings",
        ]);
        expect(launches.current).toBe(2);
        expect(newPageCalls.current).toBe(2);
        expect(closed.contexts).toBe(3);
        expect(closed.pages).toBe(2);
        expect(closed.browsers).toEqual(["browser-1", "browser-2"]);
        expect(
          decisions.map(({ policy: name, subject, outcome }) => ({
            name,
            subject,
            outcome,
          })),
        ).toEqual([
          {
            name: "sessionIsolation",
            subject: "context",
            outcome: "allowed",
          },
          {
            name: "sessionIsolation",
            subject: "page",
            outcome: "allowed",
          },
          {
            name: "originRestriction",
            subject: "navigation",
            outcome: "allowed",
          },
          {
            name: "sessionIsolation",
            subject: "context",
            outcome: "blocked",
          },
          {
            name: "sessionIsolation",
            subject: "context",
            outcome: "allowed",
          },
          {
            name: "sessionIsolation",
            subject: "page",
            outcome: "allowed",
          },
          {
            name: "originRestriction",
            subject: "navigation",
            outcome: "allowed",
          },
        ]);

        const blockedDecision = decisions.find(({ outcome }) => outcome === "blocked");
        expect(blockedDecision).toBeDefined();
        expect(blockedDecision?.ownerSessionId).not.toBeNull();
        expect(blockedDecision?.ownerSessionId).not.toBe(blockedDecision?.sessionId);
        expect(encodePolicyDecision(blockedDecision ?? decisions[0]!)).toMatchObject({
          policy: "sessionIsolation",
          subject: "context",
          outcome: "blocked",
          planId: browserPlan.id,
        });
        expect(loggedDecisions).toEqual(
          decisions.map((decision) => ({
            event: "browser.policy.decision",
            ...encodePolicyDecision(decision),
          })),
        );
      }),
  );

  it.effect(
    "blocks cross-origin redirects before DOM capture and records the origin policy decision",
    () =>
      Effect.gen(function* () {
        const policy = yield* makeInMemoryBrowserAccessSecurityPolicy({
          now: () => new Date("2026-03-06T11:00:05.000Z"),
        });
        const launches = { current: 0 };
        const contentCalls = { current: 0 };
        const screenshotCalls = { current: 0 };
        const closed = {
          browsers: 0,
          contexts: 0,
          pages: 0,
        };

        const engine: BrowserAccessEngine = {
          chromium: {
            launch: async () => {
              launches.current += 1;

              return {
                newContext: async () => ({
                  newPage: async () => ({
                    goto: async () => undefined,
                    url: async () => "https://malicious.example.net/login",
                    content: async () => {
                      contentCalls.current += 1;
                      return "<html><body><main>unexpected</main></body></html>";
                    },
                    screenshot: async () => {
                      screenshotCalls.current += 1;
                      return Uint8Array.from([9, 9, 9]);
                    },
                    evaluate: async () => ({
                      navigation: [],
                      resources: [],
                    }),
                    close: async () => {
                      closed.pages += 1;
                    },
                  }),
                  close: async () => {
                    closed.contexts += 1;
                  },
                }),
                close: async () => {
                  closed.browsers += 1;
                },
              };
            },
          },
        };

        const [failure, loggedDecisions] = yield* capturePolicyDecisionLogs(
          Effect.scoped(
            Effect.gen(function* () {
              const access = yield* BrowserAccess;
              return yield* access.capture(browserPlan).pipe(Effect.flip);
            }).pipe(
              Effect.provide(
                BrowserAccessLive({
                  engine,
                  securityPolicy: policy,
                  now: () => new Date("2026-03-06T11:00:05.000Z"),
                }),
              ),
            ),
          ),
        );
        const decisions = yield* policy.readDecisions;
        const encodedBlockedDecision = encodePolicyDecision(
          decisions.find(
            ({ policy: name, outcome }) => name === "originRestriction" && outcome === "blocked",
          ) ?? decisions[0]!,
        );
        const failureMessage = Match.value(failure).pipe(
          Match.tag("PolicyViolation", ({ message }) => message),
          Match.tag("ProviderUnavailable", ({ message }) => message),
          Match.tag("RenderCrashError", ({ message }) => message),
          Match.tag("TimeoutError", ({ message }) => message),
          Match.exhaustive,
        );

        expect(failureMessage).toContain(
          "Blocked browser navigation from expected origin https://example.com/ to https://malicious.example.net/.",
        );
        expect(contentCalls.current).toBe(0);
        expect(screenshotCalls.current).toBe(0);
        expect(launches.current).toBe(1);
        expect(closed.pages).toBe(1);
        expect(closed.contexts).toBe(1);
        expect(closed.browsers).toBe(1);
        expect(
          decisions.map(({ policy: name, subject, outcome }) => ({
            name,
            subject,
            outcome,
          })),
        ).toEqual([
          {
            name: "sessionIsolation",
            subject: "context",
            outcome: "allowed",
          },
          {
            name: "sessionIsolation",
            subject: "page",
            outcome: "allowed",
          },
          {
            name: "originRestriction",
            subject: "navigation",
            outcome: "blocked",
          },
        ]);
        expect(encodedBlockedDecision).toMatchObject({
          policy: "originRestriction",
          subject: "navigation",
          outcome: "blocked",
          expectedOrigin: "https://example.com/",
          observedOrigin: "https://malicious.example.net/",
        });
        expect(loggedDecisions).toEqual(
          decisions.map((decision) => ({
            event: "browser.policy.decision",
            ...encodePolicyDecision(decision),
          })),
        );
      }),
  );
});
