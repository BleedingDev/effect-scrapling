import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { join } from "node:path";
import {
  AccessPreviewRequestSchema,
  AccessPreviewResponseSchema,
  RenderPreviewRequestSchema,
  RenderPreviewResponseSchema,
} from "effect-scrapling/sdk";
import { runE4SdkConsumerExample } from "../../examples/e4-sdk-consumer.ts";
import { resetBrowserPoolForTests } from "../../src/sdk/browser-pool.ts";

const REPO_ROOT = import.meta.dir ? join(import.meta.dir, "..", "..") : process.cwd();

describe("E4 SDK consumer example", () => {
  it.effect("runs through the public browser contracts with typed payloads", () =>
    Effect.ensuring(
      Effect.gen(function* () {
        yield* resetBrowserPoolForTests();
        const result = yield* runE4SdkConsumerExample({
          useSyntheticBrowser: true,
        });

        const accessRequest = Schema.decodeUnknownSync(AccessPreviewRequestSchema)(
          result.payload.accessRequest,
        );
        const accessPreview = Schema.decodeUnknownSync(AccessPreviewResponseSchema)(
          result.payload.accessPreview,
        );
        const renderRequest = Schema.decodeUnknownSync(RenderPreviewRequestSchema)(
          result.payload.renderRequest,
        );
        const renderPreview = Schema.decodeUnknownSync(RenderPreviewResponseSchema)(
          result.payload.renderPreview,
        );

        expect(result.importPath).toBe("effect-scrapling/sdk");
        expect(
          result.prerequisites.some((prerequisite) => prerequisite.includes("browser:install")),
        ).toBe(true);
        expect(accessRequest.mode).toBe("browser");
        expect(accessRequest.browser?.waitUntil).toBe("commit");
        expect(accessPreview.data.finalUrl).toBe("https://consumer.example/products/sku-42");
        expect(accessPreview.data.contentType).toBe("text/html; charset=utf-8");
        expect(renderRequest.browser?.timeoutMs).toBe(900);
        expect(renderPreview.data.mode).toBe("browser");
        expect(renderPreview.data.status).toEqual({
          code: 200,
          ok: true,
          redirected: false,
          family: "success",
        });
        expect(renderPreview.data.artifacts[1]).toEqual({
          kind: "renderedDom",
          mediaType: "application/json",
          title: "Selective Browser Preview",
          textPreview:
            "Effect Scrapling browser preview Selective browser execution for high-friction targets. View offer",
          linkTargets: ["https://consumer.example/offers/sku-42?ref=browser"],
          hiddenFieldCount: 1,
        });
        expect(result.payload.expectedError.tag).toBe("InvalidInputError");
        expect(result.payload.expectedError.message).toContain("security policy");
        expect(result.payload.expectedError.details).toContain("private or reserved IPv4 range");
      }),
      resetBrowserPoolForTests(),
    ),
  );

  it("executes as a standalone example script", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "examples/e4-sdk-consumer.ts"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        EFFECT_SCRAPLING_E4_EXAMPLE_SYNTHETIC_BROWSER: "1",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr).trim()).toBe("");

    const payload = JSON.parse(new TextDecoder().decode(result.stdout));
    const accessPreview = Schema.decodeUnknownSync(AccessPreviewResponseSchema)(
      payload.payload.accessPreview,
    );
    const renderPreview = Schema.decodeUnknownSync(RenderPreviewResponseSchema)(
      payload.payload.renderPreview,
    );

    expect(payload.importPath).toBe("effect-scrapling/sdk");
    expect(accessPreview.command).toBe("access preview");
    expect(renderPreview.command).toBe("render preview");
    expect(renderPreview.data.artifacts[0]?.kind).toBe("navigation");
    expect(renderPreview.data.artifacts[1]?.title).toBe("Selective Browser Preview");
    expect(payload.payload.expectedError.tag).toBe("InvalidInputError");
  });
});
