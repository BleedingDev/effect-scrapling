import { describe, expect, it } from "@effect-native/bun-test";
import {
  REDACTED_SECRET_VALUE,
  sanitizeHeaderEntries,
  sanitizeInlineSecrets,
  sanitizeUrlForExport,
  summarizeHtmlForRedactedExport,
} from "../../libs/foundation/core/src/secret-sanitization.ts";

describe("foundation-core secret sanitization", () => {
  it("redacts sensitive header values and keeps deterministic ordering", () => {
    const sanitized = sanitizeHeaderEntries([
      ["X-Api-Key", "api-secret"],
      ["Accept", "text/html"],
      ["Cookie", "session=raw-cookie"],
      ["Authorization", "Bearer raw-token"],
      ["X-Trace-Id", "trace-001"],
    ]);

    expect(sanitized).toEqual([
      { name: "accept", value: "text/html" },
      { name: "authorization", value: REDACTED_SECRET_VALUE },
      { name: "cookie", value: REDACTED_SECRET_VALUE },
      { name: "x-api-key", value: REDACTED_SECRET_VALUE },
      { name: "x-trace-id", value: "trace-001" },
    ]);
  });

  it("sanitizes absolute and relative URLs before export", () => {
    expect(
      sanitizeUrlForExport(
        "https://user:secret@example.com/account?token=raw-token&view=full#frag",
      ),
    ).toBe(
      `https://example.com/account?token=${encodeURIComponent(REDACTED_SECRET_VALUE)}&view=full`,
    );

    expect(sanitizeUrlForExport("/checkout?session=checkout-secret#frag")).toBe(
      `/checkout?session=${encodeURIComponent(REDACTED_SECRET_VALUE)}`,
    );
  });

  it("redacts inline secrets and hidden field exports while preserving useful summaries", () => {
    const summarized = JSON.parse(
      summarizeHtmlForRedactedExport(`
        <html>
          <head>
            <title>Review token=title-secret Bearer title-bearer</title>
            <meta content="csrf=form-secret" />
          </head>
          <body>
            <main>token=body-secret password=body-password</main>
            <input type="hidden" value="checkout-hidden-secret" />
            <a href="https://user:secret@example.com/account?api_key=raw-api-key#frag">Account</a>
            <a href="/checkout?session=relative-secret#frag">Checkout</a>
          </body>
        </html>
      `),
    ) as {
      readonly title: string | null;
      readonly textPreview: string | null;
      readonly linkTargets: ReadonlyArray<string>;
      readonly hiddenFieldCount: number;
    };

    expect(summarized).toEqual({
      title: `Review token=${REDACTED_SECRET_VALUE} Bearer ${REDACTED_SECRET_VALUE}`,
      textPreview: `token=${REDACTED_SECRET_VALUE} password=${REDACTED_SECRET_VALUE} Account Checkout`,
      linkTargets: [
        `https://example.com/account?api_key=${encodeURIComponent(REDACTED_SECRET_VALUE)}`,
        `/checkout?session=${encodeURIComponent(REDACTED_SECRET_VALUE)}`,
      ],
      hiddenFieldCount: 2,
    });

    const body = JSON.stringify(summarized);
    expect(body).not.toContain("title-secret");
    expect(body).not.toContain("body-secret");
    expect(body).not.toContain("body-password");
    expect(body).not.toContain("checkout-hidden-secret");
    expect(body).not.toContain("form-secret");
    expect(body).not.toContain("raw-api-key");
    expect(sanitizeInlineSecrets("authorization: abc token=123 Bearer live-token")).toBe(
      `authorization: ${REDACTED_SECRET_VALUE} token=${REDACTED_SECRET_VALUE} Bearer ${REDACTED_SECRET_VALUE}`,
    );
  });
});
