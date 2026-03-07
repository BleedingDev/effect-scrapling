import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Match, Schema } from "effect";
import { AccessPolicySchema } from "../../libs/foundation/core/src/access-policy.ts";
import {
  CrawlPlanCompiler,
  CrawlPlanCompilerInputSchema,
  CrawlPlanCompilerLive,
  CompiledCrawlPlansSchema,
  compileCrawlPlan,
  compileCrawlPlans,
} from "../../libs/foundation/core/src/crawl-plan-runtime.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { TargetProfileSchema } from "../../libs/foundation/core/src/target-profile.ts";

const CREATED_AT = "2026-03-07T12:00:00.000Z";
const encodeCompilerInput = Schema.encodeSync(CrawlPlanCompilerInputSchema);
const encodeCompiledPlans = Schema.encodeSync(CompiledCrawlPlansSchema);

const pack = Schema.decodeUnknownSync(SitePackSchema)({
  id: "pack-example-com",
  domainPattern: "*.example.com",
  state: "shadow",
  accessPolicyId: "policy-hybrid",
  version: "2026.03.07",
});

const searchTarget = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-search-001",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "searchResult",
  canonicalKey: "search/effect-runtime",
  seedUrls: ["https://example.com/search?q=effect-runtime"],
  accessPolicyId: "policy-hybrid",
  packId: pack.id,
  priority: 90,
});

const blogTarget = Schema.decodeUnknownSync(TargetProfileSchema)({
  id: "target-blog-002",
  tenantId: "tenant-main",
  domain: "example.com",
  kind: "blogPost",
  canonicalKey: "blog/effect-runtime-deep-dive",
  seedUrls: ["https://example.com/blog/effect-runtime-deep-dive"],
  accessPolicyId: "policy-http",
  packId: "pack-blog-example-com",
  priority: 10,
});

const hybridPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-hybrid",
  mode: "hybrid",
  perDomainConcurrency: 4,
  globalConcurrency: 16,
  timeoutMs: 20_000,
  maxRetries: 2,
  render: "onDemand",
});

const httpPolicy = Schema.decodeUnknownSync(AccessPolicySchema)({
  id: "policy-http",
  mode: "http",
  perDomainConcurrency: 2,
  globalConcurrency: 8,
  timeoutMs: 15_000,
  maxRetries: 1,
  render: "never",
});

function makeCompileInput() {
  return Schema.decodeUnknownSync(CrawlPlanCompilerInputSchema)({
    createdAt: CREATED_AT,
    defaults: {
      checkpointInterval: 4,
    },
    entries: [
      {
        target: searchTarget,
        pack,
        accessPolicy: hybridPolicy,
      },
      {
        target: Schema.decodeUnknownSync(TargetProfileSchema)({
          ...Schema.encodeSync(TargetProfileSchema)(blogTarget),
          packId: pack.id,
        }),
        pack: Schema.decodeUnknownSync(SitePackSchema)({
          ...Schema.encodeSync(SitePackSchema)(pack),
          accessPolicyId: httpPolicy.id,
        }),
        accessPolicy: httpPolicy,
        runConfig: {
          mode: "browser",
          render: "always",
          timeoutMs: 45_000,
          checkpointInterval: 2,
        },
      },
    ],
  });
}

describe("foundation-core crawl plan runtime", () => {
  it.effect(
    "compiles deterministic crawl plans with explicit budgets and initial checkpoints",
    () =>
      Effect.gen(function* () {
        const input = makeCompileInput();
        const encodedInput = encodeCompilerInput(input);
        const reversedInput = {
          ...encodedInput,
          entries: [...encodedInput.entries].reverse(),
        };

        const compiled = yield* compileCrawlPlans(input);
        const reversedCompiled = yield* compileCrawlPlans(reversedInput);
        const firstCompiledByHelper = yield* compileCrawlPlan(reversedInput);
        const compiledByService = yield* Effect.gen(function* () {
          const compiler = yield* CrawlPlanCompiler;
          return yield* compiler.compile(input);
        }).pipe(Effect.provide(CrawlPlanCompilerLive()));

        expect(encodeCompiledPlans(compiled)).toEqual(encodeCompiledPlans(reversedCompiled));
        expect(encodeCompiledPlans([firstCompiledByHelper])).toEqual(
          encodeCompiledPlans([compiled[0]!]),
        );
        expect(encodeCompiledPlans(compiledByService)).toEqual(encodeCompiledPlans(compiled));
        expect(compiled.map(({ plan }) => plan.targetId)).toEqual([
          "target-search-001",
          "target-blog-002",
        ]);

        const firstPlan = compiled[0];
        const secondPlan = compiled[1];

        expect(firstPlan?.plan.steps.map(({ stage }) => stage)).toEqual([
          "capture",
          "extract",
          "snapshot",
          "diff",
          "quality",
          "reflect",
        ]);
        expect(firstPlan?.plan.steps[0]?.requiresBrowser).toBe(true);
        expect(firstPlan?.plan.steps[0]?.artifactKind).toBe("renderedDom");
        expect(firstPlan?.concurrencyBudget.globalConcurrency).toBe(16);
        expect(firstPlan?.concurrencyBudget.maxPerDomain).toBe(4);
        expect(firstPlan?.checkpoint.stage).toBe("capture");
        expect(firstPlan?.checkpoint.pendingStepIds).toEqual([
          "step-capture",
          "step-extract",
          "step-snapshot",
          "step-diff",
          "step-quality",
          "step-reflect",
        ]);
        expect(firstPlan?.checkpoint.stats.completedSteps).toBe(0);
        expect(firstPlan?.checkpoint.stats.checkpointCount).toBe(1);

        expect(secondPlan?.resolvedConfig.mode).toBe("browser");
        expect(secondPlan?.resolvedConfig.render).toBe("always");
        expect(secondPlan?.resolvedConfig.timeoutMs).toBe(45_000);
        expect(secondPlan?.plan.steps[0]?.requiresBrowser).toBe(true);
        expect(secondPlan?.plan.maxAttempts).toBe(2);
        expect(secondPlan?.plan.checkpointInterval).toBe(2);
        expect(secondPlan?.checkpoint.nextStepId).toBe("step-capture");
      }),
  );

  it.effect("compiles exact-domain site packs without requiring wildcard domain patterns", () =>
    Effect.gen(function* () {
      const exactPack = Schema.decodeUnknownSync(SitePackSchema)({
        ...Schema.encodeSync(SitePackSchema)(pack),
        id: "pack-root-example-com",
        domainPattern: "example.com",
      });
      const exactTarget = Schema.decodeUnknownSync(TargetProfileSchema)({
        ...Schema.encodeSync(TargetProfileSchema)(searchTarget),
        id: "target-root-domain-003",
        canonicalKey: "search/root-domain",
        packId: exactPack.id,
      });

      const compiled = yield* compileCrawlPlan({
        createdAt: CREATED_AT,
        entries: [
          {
            target: exactTarget,
            pack: exactPack,
            accessPolicy: hybridPolicy,
          },
        ],
      });

      const entryUrl = exactTarget.seedUrls[0];
      if (entryUrl === undefined) {
        throw new Error("Expected exact-domain target fixture to include a seed URL.");
      }

      expect(compiled.plan.targetId).toBe(exactTarget.id);
      expect(compiled.resolvedConfig.packId).toBe(exactPack.id);
      expect(compiled.resolvedConfig.entryUrl).toBe(entryUrl);
      expect(compiled.checkpoint.pendingStepIds).toEqual([
        "step-capture",
        "step-extract",
        "step-snapshot",
        "step-diff",
        "step-quality",
        "step-reflect",
      ]);
    }),
  );

  it.effect("rejects malformed compiler inputs through shared contracts", () =>
    Effect.gen(function* () {
      const encodedInput = encodeCompilerInput(makeCompileInput());
      const error = yield* compileCrawlPlans({
        ...encodedInput,
        entries: [encodedInput.entries[0]!, encodedInput.entries[0]!],
      }).pipe(Effect.flip);

      yield* Match.value(error).pipe(
        Match.tag("PolicyViolation", ({ message }) =>
          Effect.sync(() => {
            expect(message).toBe(
              "Failed to decode crawl-plan compiler input through shared contracts.",
            );
          }),
        ),
        Match.exhaustive,
      );
    }),
  );

  it.effect("rejects configs that drift target ownership identifiers", () =>
    Effect.gen(function* () {
      const error = yield* compileCrawlPlans({
        ...encodeCompilerInput(makeCompileInput()),
        entries: [
          {
            ...encodeCompilerInput(makeCompileInput()).entries[0],
            runConfig: {
              targetId: "target-other",
            },
          },
        ],
      }).pipe(Effect.flip);

      yield* Match.value(error).pipe(
        Match.tag("PolicyViolation", ({ message }) =>
          Effect.sync(() => {
            expect(message).toContain("must preserve targetId, packId, and accessPolicyId");
          }),
        ),
        Match.exhaustive,
      );
    }),
  );

  it.effect(
    "rejects configs that escape target domains or violate access-policy compatibility",
    () =>
      Effect.gen(function* () {
        const domainFailure = yield* compileCrawlPlans({
          ...encodeCompilerInput(makeCompileInput()),
          entries: [
            {
              ...encodeCompilerInput(makeCompileInput()).entries[0],
              runConfig: {
                entryUrl: "https://evil.example.net/off-domain",
              },
            },
          ],
        }).pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

        expect(domainFailure).not.toBe("unexpected-success");
        expect(domainFailure).toContain("Configured entry URL host");

        const policyFailure = yield* compileCrawlPlans({
          ...encodeCompilerInput(makeCompileInput()),
          entries: [
            {
              ...encodeCompilerInput(makeCompileInput()).entries[0],
              runConfig: {
                mode: "http",
                render: "always",
              },
            },
          ],
        }).pipe(
          Effect.match({
            onFailure: ({ message }) => message,
            onSuccess: () => "unexpected-success",
          }),
        );

        expect(policyFailure).not.toBe("unexpected-success");
        expect(policyFailure).toContain("must satisfy the access policy contract");
      }),
  );
});
