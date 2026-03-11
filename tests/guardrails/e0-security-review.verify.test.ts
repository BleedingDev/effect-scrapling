import { describe, expect, it } from "@effect-native/bun-test";
import { mock } from "bun:test";
import { Effect } from "effect";
import { provideSdkEnvironment } from "../../src/sdk/runtime-layer.ts";
import {
  accessPreview,
  extractRun,
  FetchService,
  type FetchClient,
} from "../../src/sdk/scraper.ts";

describe("E0 security review verification", () => {
  it.effect("rejects direct private-network targets before any fetch occurs", () =>
    Effect.gen(function* () {
      let fetchCalls = 0;

      const fetchClient: FetchClient = async () => {
        fetchCalls += 1;
        return new Response("unexpected");
      };

      const failureMessage = yield* accessPreview({
        url: "http://127.0.0.1/admin",
      }).pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected InvalidInputError failure"))),
        Effect.catchTag("InvalidInputError", ({ message }) => Effect.succeed(message)),
        Effect.provideService(FetchService, {
          fetch: fetchClient,
        }),
        provideSdkEnvironment,
        Effect.orDie,
      );

      expect(failureMessage).toContain("security policy");
      expect(fetchCalls).toBe(0);
    }),
  );

  it.effect("blocks redirect pivots into localhost targets", () =>
    Effect.gen(function* () {
      const requestedUrls: string[] = [];

      const fetchClient: FetchClient = async (input) => {
        requestedUrls.push(new Request(input).url);

        if (requestedUrls.length === 1) {
          return new Response("", {
            status: 302,
            headers: {
              location: "http://127.0.0.1/internal",
            },
          });
        }

        return new Response("<html>unexpected</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      };

      const failureDetails = yield* accessPreview({
        url: "https://example.com/start",
      }).pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected NetworkError failure"))),
        Effect.catchTag("NetworkError", ({ details }) => Effect.succeed(details)),
        Effect.provideService(FetchService, {
          fetch: fetchClient,
        }),
        provideSdkEnvironment,
        Effect.orDie,
      );

      expect(failureDetails).toContain("private or reserved");
      expect(requestedUrls).toEqual(["https://example.com/start"]);
    }),
  );

  it.effect("blocks browser-mode subrequests into localhost targets at runtime", () =>
    Effect.gen(function* () {
      const continuedUrls: string[] = [];
      const abortedUrls: string[] = [];

      mock.module("patchright", () => ({
        chromium: {
          launch: async () => ({
            newContext: async () => ({
              newPage: async () => {
                let routeHandler:
                  | ((route: {
                      readonly request: () => { readonly url: () => string };
                      readonly continue: () => Promise<void>;
                      readonly abort: (errorCode?: string) => Promise<void>;
                    }) => Promise<void> | void)
                  | undefined;

                return {
                  route: async (
                    _matcher: string,
                    handler: NonNullable<typeof routeHandler>,
                  ): Promise<void> => {
                    routeHandler = handler;
                  },
                  goto: async (url: string) => {
                    if (!routeHandler) {
                      throw new Error("Expected browser route interception to be installed");
                    }

                    const createRoute = (requestUrl: string) => ({
                      request: () => ({
                        url: () => requestUrl,
                      }),
                      continue: async () => {
                        continuedUrls.push(requestUrl);
                      },
                      abort: async () => {
                        abortedUrls.push(requestUrl);
                      },
                    });

                    await routeHandler(createRoute(url));
                    await routeHandler(createRoute("http://127.0.0.1/internal"));

                    return {
                      status: () => 200,
                      allHeaders: async () => ({
                        "content-type": "text/html; charset=utf-8",
                      }),
                    };
                  },
                  content: async () => "<html><body><h1>unexpected</h1></body></html>",
                  url: () => "https://example.com/browser-start",
                  waitForLoadState: async () => {},
                  close: async () => {},
                };
              },
              close: async () => {},
            }),
            close: async () => {},
          }),
        },
      }));

      const failureDetails = yield* accessPreview({
        url: "https://example.com/browser-start",
        execution: {
          providerId: "browser-basic",
        },
      }).pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected BrowserError failure"))),
        Effect.catchTag("BrowserError", ({ details }) => Effect.succeed(details)),
        Effect.provideService(FetchService, {
          fetch: globalThis.fetch,
        }),
        provideSdkEnvironment,
        Effect.orDie,
        Effect.ensuring(Effect.sync(() => mock.restore())),
      );

      expect(failureDetails).toContain("Blocked browser request");
      expect(continuedUrls).toEqual(["https://example.com/browser-start"]);
      expect(abortedUrls).toEqual(["http://127.0.0.1/internal"]);
    }),
  );

  it.effect("rejects direct private-network targets for extractRun before any fetch occurs", () =>
    Effect.gen(function* () {
      let fetchCalls = 0;

      const fetchClient: FetchClient = async () => {
        fetchCalls += 1;
        return new Response("unexpected");
      };

      const failureMessage = yield* extractRun({
        url: "http://127.0.0.1/admin",
        selector: "h1",
      }).pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected InvalidInputError failure"))),
        Effect.catchTag("InvalidInputError", ({ message }) => Effect.succeed(message)),
        Effect.provideService(FetchService, {
          fetch: fetchClient,
        }),
        provideSdkEnvironment,
        Effect.orDie,
      );

      expect(failureMessage).toContain("security policy");
      expect(fetchCalls).toBe(0);
    }),
  );

  it.effect("blocks redirect pivots into localhost targets for extractRun", () =>
    Effect.gen(function* () {
      const requestedUrls: string[] = [];

      const fetchClient: FetchClient = async (input) => {
        requestedUrls.push(new Request(input).url);

        if (requestedUrls.length === 1) {
          return new Response("", {
            status: 302,
            headers: {
              location: "http://127.0.0.1/internal",
            },
          });
        }

        return new Response("<html>unexpected</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      };

      const failureDetails = yield* extractRun({
        url: "https://example.com/start",
        selector: "h1",
      }).pipe(
        Effect.flatMap(() => Effect.die(new Error("Expected NetworkError failure"))),
        Effect.catchTag("NetworkError", ({ details }) => Effect.succeed(details)),
        Effect.provideService(FetchService, {
          fetch: fetchClient,
        }),
        provideSdkEnvironment,
        Effect.orDie,
      );

      expect(failureDetails).toContain("private or reserved");
      expect(requestedUrls).toEqual(["https://example.com/start"]);
    }),
  );
});
