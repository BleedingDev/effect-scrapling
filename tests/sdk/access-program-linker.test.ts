import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Layer } from "effect";
import { AccessSelectionPolicy } from "../../src/sdk/access-policy-runtime.ts";
import { AccessProgramLinker } from "../../src/sdk/access-program-linker.ts";
import { provideSdkRuntime } from "../../src/sdk/runtime-layer.ts";

describe("sdk access program linker", () => {
  it.effect("builds a canonical IR with prelinked command programs", () =>
    provideSdkRuntime(
      Effect.gen(function* () {
        const linker = yield* AccessProgramLinker;
        const ir = yield* linker.inspectIr();
        const programs = yield* linker.listPrograms();

        expect(ir.irVersion).toBe("v1");
        expect(ir.moduleIds.length).toBeGreaterThan(0);
        expect(ir.providers.some((provider) => provider.id === "http-basic")).toBe(true);
        expect(programs.map(({ program }) => program.programId)).toEqual([
          "access-preview",
          "extract-run",
          "render-preview",
        ]);
        expect(
          programs.find(({ program }) => program.command === "access")?.program.fallbackEdges[0],
        ).toEqual(
          expect.objectContaining({
            edgeId: "browser-on-access-wall",
            kind: "browser-on-access-wall",
          }),
        );
      }),
    ),
  );

  it.effect(
    "specializes linked programs without inventing providers outside the linked topology",
    () =>
      provideSdkRuntime(
        Effect.gen(function* () {
          const linker = yield* AccessProgramLinker;
          const specialized = yield* linker.specialize({
            command: "access",
            url: "https://example.com/products/sku-1",
            defaultTimeoutMs: 500,
            defaultProviderId: "http-basic",
          });

          expect(specialized.program.programId).toBe("access-preview");
          expect(specialized.trace.selectedProviderId).toBe("http-basic");
          expect(specialized.trace.candidateProviderIds).toContain("http-basic");
          expect(specialized.trace.rejectedProviderIds).not.toContain("http-basic");
          expect(specialized.trace.appliedFallbackEdgeIds).toEqual(["browser-on-access-wall"]);
          expect(specialized.intent.fallback?.browserOnAccessWall?.providerId).toBe(
            "browser-basic",
          );
        }),
      ),
  );

  it.effect("specializes the dedicated extract program for extract flows", () =>
    provideSdkRuntime(
      Effect.gen(function* () {
        const linker = yield* AccessProgramLinker;
        const specialized = yield* linker.specialize({
          command: "extract",
          url: "https://example.com/products/sku-1",
          defaultTimeoutMs: 500,
          defaultProviderId: "http-basic",
        });

        expect(specialized.program.programId).toBe("extract-run");
      }),
    ),
  );

  it.effect(
    "re-resolves browser fallback through selection policy and browser profile defaults",
    () =>
      provideSdkRuntime(
        Effect.gen(function* () {
          const linker = yield* AccessProgramLinker;
          const specialized = yield* linker.specialize({
            command: "access",
            url: "https://example.com/products/sku-1",
            defaultTimeoutMs: 500,
            defaultProviderId: "http-basic",
          });

          expect(specialized.intent.providerId).toBe("http-basic");
          expect(specialized.intent.fallback?.browserOnAccessWall?.providerId).toBe(
            "browser-stealth",
          );
          expect(specialized.intent.fallback?.browserOnAccessWall?.identity.profileId).toBe(
            "stealth-default",
          );
          expect(specialized.intent.fallback?.browserOnAccessWall?.browser?.runtimeProfileId).toBe(
            "patchright-stealth",
          );
        }),
        Layer.succeed(AccessSelectionPolicy, {
          resolveSelection: ({ execution }) =>
            Effect.succeed(
              execution?.mode === "browser"
                ? {
                    providerId: "browser-stealth",
                    mode: "browser" as const,
                    warnings: ["fallback-rerouted:browser-stealth"],
                  }
                : {
                    providerId: "http-basic",
                    mode: "http" as const,
                    warnings: [],
                  },
            ),
        }),
      ),
  );
});
