import { describe, expect, it } from "@effect-native/bun-test";
import { normalizePayload } from "../src/api-request-payload";

describe("api request payload normalization", () => {
  it("preserves extract-run fields and browser aliases for schema decoding", () => {
    expect(
      normalizePayload("extract", {
        url: "https://example.com",
        selector: "h1",
        attr: "href",
        all: "TRUE",
        limit: "05",
        "timeout-ms": "300",
        "wait-until": "load",
        "browser-user-agent": "Example Browser",
      }),
    ).toEqual({
      url: "https://example.com",
      selector: "h1",
      attr: "href",
      all: "TRUE",
      limit: "05",
      timeoutMs: "300",
      mode: undefined,
      userAgent: undefined,
      browser: {
        waitUntil: "load",
        timeoutMs: undefined,
        userAgent: "Example Browser",
      },
    });
  });

  it("normalizes nested browser aliases without losing access-preview fields", () => {
    expect(
      normalizePayload("access", {
        url: "https://example.com",
        mode: "browser",
        browser: {
          "wait-until": "commit",
          "timeout-ms": "450",
          "user-agent": "Nested Browser",
        },
      }),
    ).toEqual({
      url: "https://example.com",
      timeoutMs: undefined,
      userAgent: undefined,
      mode: "browser",
      browser: {
        waitUntil: "commit",
        timeoutMs: "450",
        userAgent: "Nested Browser",
      },
    });
  });
});
