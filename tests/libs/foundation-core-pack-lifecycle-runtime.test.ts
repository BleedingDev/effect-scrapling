import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import { transitionPackLifecycle } from "../../libs/foundation/core/src/pack-lifecycle-runtime.ts";
import { SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";

function makePack(state: "draft" | "shadow" | "active" | "guarded" | "quarantined" | "retired") {
  return Schema.decodeUnknownSync(SitePackSchema)({
    id: `pack-${state}-001`,
    tenantId: "tenant-main",
    domainPattern: "*.example.com",
    state,
    accessPolicyId: "policy-default",
    version: "2026.03.08",
  });
}

describe("foundation-core pack lifecycle runtime", () => {
  it.effect("promotes draft packs to shadow and records a typed transition event", () =>
    Effect.gen(function* () {
      const result = yield* transitionPackLifecycle({
        pack: makePack("draft"),
        to: "shadow",
        changedBy: "curator-main",
        rationale: "initial validation passed",
        occurredAt: "2026-03-08T12:00:00.000Z",
      });

      expect(result.pack.state).toBe("shadow");
      expect(result.event).toMatchObject({
        packId: "pack-draft-001",
        packVersion: "2026.03.08",
        from: "draft",
        to: "shadow",
        changedBy: "curator-main",
      });
      expect(result.event.id).toContain("pack-transition-pack-draft-001");
    }),
  );

  it.effect("moves active packs into guarded state without mutating the pack identity", () =>
    Effect.gen(function* () {
      const result = yield* transitionPackLifecycle({
        pack: makePack("active"),
        to: "guarded",
        changedBy: "curator-main",
        rationale: "canary drift exceeded the allowed threshold",
        occurredAt: "2026-03-08T12:05:00.000Z",
      });

      expect(result.pack).toMatchObject({
        id: "pack-active-001",
        tenantId: "tenant-main",
        domainPattern: "*.example.com",
        version: "2026.03.08",
        state: "guarded",
      });
      expect(result.event.from).toBe("active");
      expect(result.event.to).toBe("guarded");
    }),
  );

  it.effect("rejects invalid lifecycle transitions outside the state machine", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        transitionPackLifecycle({
          pack: makePack("draft"),
          to: "active",
          changedBy: "curator-main",
          rationale: "skip shadow",
          occurredAt: "2026-03-08T12:10:00.000Z",
        }),
      );

      expect(error.message).toContain("valid pack lifecycle transition");
      expect(error.message).toContain("draft");
      expect(error.message).toContain("active");
    }),
  );

  it.effect("rejects malformed transition requests through shared schema contracts", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        transitionPackLifecycle({
          pack: makePack("quarantined"),
          to: "shadow",
          changedBy: "   ",
          rationale: "operator override",
          occurredAt: "not-a-date",
        }),
      );

      expect(error.message).toMatch(/changedBy|occurredAt/u);
    }),
  );
});
