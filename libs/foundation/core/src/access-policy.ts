import { Schema } from "effect";
import { CanonicalIdentifierSchema, TimeoutMsSchema } from "./schema-primitives.ts";

export const AccessModeSchema = Schema.Literals(["http", "browser", "hybrid", "managed"] as const);

export const RenderingPolicySchema = Schema.Literals(["never", "onDemand", "always"] as const);

const PerDomainConcurrencySchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(128),
);
const GlobalConcurrencySchema = Schema.Int.check(Schema.isGreaterThan(0)).check(
  Schema.isLessThanOrEqualTo(4096),
);
const MaxRetriesSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(10),
);

class AccessPolicyBase extends Schema.Class<AccessPolicyBase>("AccessPolicy")({
  id: CanonicalIdentifierSchema,
  mode: AccessModeSchema,
  perDomainConcurrency: PerDomainConcurrencySchema,
  globalConcurrency: GlobalConcurrencySchema,
  timeoutMs: TimeoutMsSchema,
  maxRetries: MaxRetriesSchema,
  render: RenderingPolicySchema,
}) {}

export const AccessPolicySchema = AccessPolicyBase.pipe(
  Schema.refine(
    (value): value is Schema.Schema.Type<typeof AccessPolicyBase> =>
      value.globalConcurrency >= value.perDomainConcurrency &&
      (value.render !== "never" || value.mode === "http") &&
      (value.mode !== "http" || value.render === "never"),
    {
      message:
        "Expected globalConcurrency >= perDomainConcurrency and rendering modes compatible with access mode.",
    },
  ),
);

export type AccessMode = Schema.Schema.Type<typeof AccessModeSchema>;
export type RenderingPolicy = Schema.Schema.Type<typeof RenderingPolicySchema>;
export type AccessPolicy = Schema.Schema.Type<typeof AccessPolicySchema>;
export type AccessPolicyEncoded = Schema.Codec.Encoded<typeof AccessPolicySchema>;
