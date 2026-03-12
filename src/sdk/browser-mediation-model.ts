import { Schema } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const BrowserMediationModeSchema = Schema.Literals(["off", "detect", "solve"] as const);

export const BrowserMediationKindSchema = Schema.Literals([
  "none",
  "challenge",
  "consent",
  "trap",
  "unknown",
] as const);

export const BrowserMediationVendorSchema = Schema.Literals(["cloudflare"] as const);

export const BrowserMediationResolutionKindSchema = Schema.Literals([
  "wait",
  "click",
  "reload-target",
  "reuse-current",
  "skip",
] as const);

export const BrowserMediationFailureReasonSchema = Schema.Literals([
  "no-progress",
  "budget-exhausted",
  "unsupported-surface",
  "policy-disabled",
  "detection-low-confidence",
  "adapter-error",
] as const);

export const BrowserMediationStatusSchema = Schema.Literals([
  "none",
  "detected",
  "attempted",
  "cleared",
  "unresolved",
  "aborted",
] as const);

export const BrowserMediationPostClearanceStrategySchema = Schema.Literals([
  "auto",
  "reload-target",
  "reuse-current",
] as const);

export const BrowserMediationPolicySchema = Schema.Struct({
  mode: BrowserMediationModeSchema,
  vendors: Schema.Array(BrowserMediationVendorSchema),
  maxAttempts: PositiveInt,
  timeBudgetMs: PositiveInt,
  postClearanceStrategy: BrowserMediationPostClearanceStrategySchema,
  captureEvidence: Schema.Boolean,
});

export const BrowserNavigationSnapshotSchema = Schema.Struct({
  requestedUrl: Schema.String,
  finalUrl: Schema.String,
  status: PositiveInt,
  title: Schema.NullOr(Schema.String),
  contentType: Schema.String,
  htmlLength: NonNegativeInt,
  redirectCount: NonNegativeInt,
});

export const BrowserMediationEvidenceSchema = Schema.Struct({
  preNavigation: Schema.optional(BrowserNavigationSnapshotSchema),
  postNavigation: Schema.optional(BrowserNavigationSnapshotSchema),
  signals: Schema.Array(Schema.String),
});

export const BrowserMediationTimingSchema = Schema.Struct({
  detectionMs: Schema.optional(NonNegativeNumber),
  resolutionMs: Schema.optional(NonNegativeNumber),
  followUpNavigationMs: Schema.optional(NonNegativeNumber),
});

export const BrowserMediationOutcomeSchema = Schema.Struct({
  kind: BrowserMediationKindSchema,
  status: BrowserMediationStatusSchema,
  vendor: Schema.optional(BrowserMediationVendorSchema),
  resolutionKind: Schema.optional(BrowserMediationResolutionKindSchema),
  failureReason: Schema.optional(BrowserMediationFailureReasonSchema),
  attemptCount: NonNegativeInt,
  evidence: BrowserMediationEvidenceSchema,
  timings: BrowserMediationTimingSchema,
});

export type BrowserMediationMode = Schema.Schema.Type<typeof BrowserMediationModeSchema>;
export type BrowserMediationKind = Schema.Schema.Type<typeof BrowserMediationKindSchema>;
export type BrowserMediationVendor = Schema.Schema.Type<typeof BrowserMediationVendorSchema>;
export type BrowserMediationResolutionKind = Schema.Schema.Type<
  typeof BrowserMediationResolutionKindSchema
>;
export type BrowserMediationFailureReason = Schema.Schema.Type<
  typeof BrowserMediationFailureReasonSchema
>;
export type BrowserMediationStatus = Schema.Schema.Type<typeof BrowserMediationStatusSchema>;
export type BrowserMediationPolicy = Schema.Schema.Type<typeof BrowserMediationPolicySchema>;
export type BrowserNavigationSnapshot = Schema.Schema.Type<typeof BrowserNavigationSnapshotSchema>;
export type BrowserMediationEvidence = Schema.Schema.Type<typeof BrowserMediationEvidenceSchema>;
export type BrowserMediationTiming = Schema.Schema.Type<typeof BrowserMediationTimingSchema>;
export type BrowserMediationOutcome = Schema.Schema.Type<typeof BrowserMediationOutcomeSchema>;

export const DEFAULT_BROWSER_MEDIATION_POLICY: BrowserMediationPolicy = {
  mode: "off",
  vendors: [],
  maxAttempts: 2,
  timeBudgetMs: 15_000,
  postClearanceStrategy: "auto",
  captureEvidence: false,
};

export function makeBrowserMediationPolicy(
  overrides: Partial<BrowserMediationPolicy> = {},
): BrowserMediationPolicy {
  return {
    ...DEFAULT_BROWSER_MEDIATION_POLICY,
    ...overrides,
  };
}

export function makeEmptyBrowserMediationOutcome(): BrowserMediationOutcome {
  return {
    kind: "none",
    status: "none",
    attemptCount: 0,
    evidence: {
      signals: [],
    },
    timings: {},
  };
}

export function didBrowserMediationAttempt(outcome: BrowserMediationOutcome) {
  return outcome.attemptCount > 0 || outcome.status === "attempted" || outcome.status === "cleared";
}

export function isBrowserMediationCleared(outcome: BrowserMediationOutcome) {
  return outcome.status === "cleared";
}
