import { Layer, ServiceMap } from "effect";
import { type BunFetchProxyConfig } from "./egress-route-config.ts";

export type FetchRequestInit = Parameters<typeof fetch>[1] & {
  readonly proxy?: BunFetchProxyConfig | undefined;
};

export type FetchClient = (
  input: Parameters<typeof fetch>[0],
  init?: FetchRequestInit,
) => ReturnType<typeof fetch>;

type FetchServiceShape = {
  readonly fetch: FetchClient;
};

export class FetchService extends ServiceMap.Service<FetchService, FetchServiceShape>()(
  "@effect-scrapling/FetchService",
) {}

export const FetchServiceLive = Layer.succeed(FetchService)({
  fetch: globalThis.fetch,
});
