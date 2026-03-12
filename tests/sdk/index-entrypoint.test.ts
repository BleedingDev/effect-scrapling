import { describe, expect, it } from "@effect-native/bun-test";

describe("sdk index entrypoint", () => {
  it("keeps a curated public and host surface without leaking internal registries", async () => {
    const sdk = await import("../../src/sdk/index.ts");

    expect(sdk.createEngine).toBeDefined();
    expect(sdk.defineAccessModule).toBeDefined();
    expect(sdk.createSdkEngine).toBeDefined();
    expect(sdk.provideSdkRuntime).toBeDefined();
    expect(sdk.FetchService).toBeDefined();

    expect("AccessProviderRegistry" in sdk).toBe(false);
    expect("BrowserRuntime" in sdk).toBe(false);
    expect("resetBrowserPoolForTests" in sdk).toBe(false);
  });
});
