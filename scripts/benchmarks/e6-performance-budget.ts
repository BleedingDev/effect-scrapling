#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  E6CapabilitySliceEvidenceSchema,
  runE6CapabilitySlice,
} from "../../examples/e6-capability-slice.ts";
import { Effect, Option, Schema, SchemaGetter } from "effect";
import { SnapshotDiffSchema } from "../../libs/foundation/core/src/diff-verdict.ts";
import {
  PackGovernanceResultSchema,
  VersionedSitePackArtifactSchema,
  applyPackGovernanceDecision,
} from "../../libs/foundation/core/src/pack-governance-runtime.ts";
import { PackCandidateSignalSchema } from "../../libs/foundation/core/src/pack-candidate-generator.ts";
import { transitionPackLifecycle } from "../../libs/foundation/core/src/pack-lifecycle-runtime.ts";
import { resolvePackRegistryLookup } from "../../libs/foundation/core/src/pack-registry-runtime.ts";
import { decidePackPromotion } from "../../libs/foundation/core/src/reflection-engine-runtime.ts";
import {
  PackReflectionRecommendationSchema,
  synthesizePackReflection,
} from "../../libs/foundation/core/src/reflector-runtime.ts";
import { SitePackDslSchema, SitePackSchema } from "../../libs/foundation/core/src/site-pack.ts";
import { evaluateValidatorLadder } from "../../libs/foundation/core/src/validator-ladder-runtime.ts";

const CREATED_AT = "2026-03-08T12:00:00.000Z";
const LOOKUP_DOMAIN = "shop.example.com";
const LOOKUP_TENANT_ID = "tenant-main";
const GOVERNANCE_NEXT_VERSION = "2026.03.09";
const REGISTRY_STATES = ["shadow", "active"] as const;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmptyStringSchema = Schema.Trim.check(Schema.isNonEmpty());
const PositiveIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThan(0),
);
const NonNegativeIntFromString = Schema.FiniteFromString.check(Schema.isInt()).check(
  Schema.isGreaterThanOrEqualTo(0),
);
const PositiveIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(PositiveIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);
const NonNegativeIntArgumentSchema = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(/^\d+$/u)),
  Schema.decodeTo(NonNegativeIntFromString, {
    decode: SchemaGetter.passthrough(),
    encode: SchemaGetter.String(),
  }),
);

export const DEFAULT_SAMPLE_SIZE = 12;
export const DEFAULT_WARMUP_ITERATIONS = 3;
export const WORKLOAD_PROFILE = {
  catalogSize: 192,
  capabilitySliceRunsPerSample: 3,
  registryLookupsPerSample: 128,
  signalPairs: 24,
  reflectionIterationsPerSample: 12,
  governanceIterationsPerSample: 12,
  minimumOccurrenceCount: 2,
} as const;

export const PERFORMANCE_BUDGETS = {
  capabilitySliceP95Ms: 25,
  registryResolutionP95Ms: 25,
  reflectionRecommendationP95Ms: 100,
  promotionGovernanceP95Ms: 100,
  heapDeltaKiB: 16_384,
} as const;

export const BenchmarkSummarySchema = Schema.Struct({
  samples: PositiveIntSchema,
  minMs: Schema.Finite,
  meanMs: Schema.Finite,
  p95Ms: Schema.Finite,
  maxMs: Schema.Finite,
});

export const WorkloadProfileSchema = Schema.Struct({
  catalogSize: PositiveIntSchema,
  capabilitySliceRunsPerSample: PositiveIntSchema,
  registryLookupsPerSample: PositiveIntSchema,
  signalCount: PositiveIntSchema,
  reflectionIterationsPerSample: PositiveIntSchema,
  governanceCatalogArtifacts: PositiveIntSchema,
  governanceIterationsPerSample: PositiveIntSchema,
  minimumOccurrenceCount: PositiveIntSchema,
});

const StabilityFieldSchema = Schema.Struct({
  expected: NonEmptyStringSchema,
  observed: NonEmptyStringSchema,
  consistent: Schema.Boolean,
});

export const CapabilitySliceObservationSchema = Schema.Struct({
  resolvedPackFingerprint: NonEmptyStringSchema,
  clusterFingerprint: NonEmptyStringSchema,
  proposalFingerprint: NonEmptyStringSchema,
  qualityAction: NonEmptyStringSchema,
  decisionAction: NonEmptyStringSchema,
  governanceAuditFingerprint: NonEmptyStringSchema,
  activeVersion: NonEmptyStringSchema,
});

export const RegistryResolutionObservationSchema = Schema.Struct({
  resolvedPackFingerprint: NonEmptyStringSchema,
});

export const ReflectionRecommendationObservationSchema = Schema.Struct({
  clusterFingerprint: NonEmptyStringSchema,
  proposalFingerprint: NonEmptyStringSchema,
});

export const PromotionGovernanceObservationSchema = Schema.Struct({
  qualityAction: NonEmptyStringSchema,
  decisionAction: NonEmptyStringSchema,
  governanceAuditFingerprint: NonEmptyStringSchema,
  activeVersion: NonEmptyStringSchema,
});

export const BenchmarkStabilitySchema = Schema.Struct({
  resolvedPackFingerprint: StabilityFieldSchema,
  clusterFingerprint: StabilityFieldSchema,
  proposalFingerprint: StabilityFieldSchema,
  qualityAction: StabilityFieldSchema,
  decisionAction: StabilityFieldSchema,
  governanceAuditFingerprint: StabilityFieldSchema,
  activeVersion: StabilityFieldSchema,
  registryResolvedPackFingerprint: StabilityFieldSchema,
  reflectionClusterFingerprint: StabilityFieldSchema,
  reflectionProposalFingerprint: StabilityFieldSchema,
  promotionQualityAction: StabilityFieldSchema,
  promotionDecisionAction: StabilityFieldSchema,
  promotionGovernanceAuditFingerprint: StabilityFieldSchema,
  promotionActiveVersion: StabilityFieldSchema,
});

export const BenchmarkArtifactSchema = Schema.Struct({
  benchmark: Schema.Literal("e6-performance-budget"),
  generatedAt: Schema.String,
  environment: Schema.Struct({
    bun: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
  }),
  sampleSize: PositiveIntSchema,
  warmupIterations: NonNegativeIntSchema,
  profile: WorkloadProfileSchema,
  budgets: Schema.Struct({
    capabilitySliceP95Ms: PositiveIntSchema,
    registryResolutionP95Ms: PositiveIntSchema,
    reflectionRecommendationP95Ms: PositiveIntSchema,
    promotionGovernanceP95Ms: PositiveIntSchema,
    heapDeltaKiB: PositiveIntSchema,
  }),
  measurements: Schema.Struct({
    capabilitySlice: BenchmarkSummarySchema,
    registryResolution: BenchmarkSummarySchema,
    reflectionRecommendation: BenchmarkSummarySchema,
    promotionGovernance: BenchmarkSummarySchema,
    heapDeltaKiB: Schema.Finite,
  }),
  stability: BenchmarkStabilitySchema,
  comparison: Schema.Struct({
    baselinePath: Schema.NullOr(Schema.String),
    comparable: Schema.Boolean,
    incompatibleReason: Schema.NullOr(NonEmptyStringSchema),
    deltas: Schema.Struct({
      capabilitySliceP95Ms: Schema.NullOr(Schema.Finite),
      registryResolutionP95Ms: Schema.NullOr(Schema.Finite),
      reflectionRecommendationP95Ms: Schema.NullOr(Schema.Finite),
      promotionGovernanceP95Ms: Schema.NullOr(Schema.Finite),
      heapDeltaKiB: Schema.NullOr(Schema.Finite),
    }),
  }),
  violations: Schema.Array(Schema.String),
  status: Schema.Literals(["pass", "fail"] as const),
});

type CapabilityEvidence = Schema.Schema.Type<typeof E6CapabilitySliceEvidenceSchema>;
export type BenchmarkSummary = Schema.Schema.Type<typeof BenchmarkSummarySchema>;
export type WorkloadProfile = Schema.Schema.Type<typeof WorkloadProfileSchema>;
export type CapabilitySliceObservation = Schema.Schema.Type<
  typeof CapabilitySliceObservationSchema
>;
export type RegistryResolutionObservation = Schema.Schema.Type<
  typeof RegistryResolutionObservationSchema
>;
export type ReflectionRecommendationObservation = Schema.Schema.Type<
  typeof ReflectionRecommendationObservationSchema
>;
export type PromotionGovernanceObservation = Schema.Schema.Type<
  typeof PromotionGovernanceObservationSchema
>;
export type BenchmarkArtifact = Schema.Schema.Type<typeof BenchmarkArtifactSchema>;
export type BenchmarkStability = Schema.Schema.Type<typeof BenchmarkStabilitySchema>;

export const EXPECTED_CAPABILITY_OBSERVATION = Schema.decodeUnknownSync(
  CapabilitySliceObservationSchema,
)({
  resolvedPackFingerprint: "pack-shop-example-com:shadow@2026.03.08",
  clusterFingerprint: "price:selectorRegressionPattern:2>title:fixtureConsensusPattern:2",
  proposalFingerprint:
    "price:promoteSelectorCandidate:price/fallback>title:appendSelectorCandidate:title/secondary",
  qualityAction: "active",
  decisionAction: "active",
  governanceAuditFingerprint: "demote-previous-active>activate-version",
  activeVersion: "2026.03.09",
});

export const EXPECTED_REGISTRY_RESOLUTION_OBSERVATION = Schema.decodeUnknownSync(
  RegistryResolutionObservationSchema,
)({
  resolvedPackFingerprint: "pack-shop-example-com-shadow:shadow@2026.03.08",
});

export const EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION = Schema.decodeUnknownSync(
  ReflectionRecommendationObservationSchema,
)({
  clusterFingerprint: "price:selectorRegressionPattern:24>title:fixtureConsensusPattern:24",
  proposalFingerprint: EXPECTED_CAPABILITY_OBSERVATION.proposalFingerprint,
});

export const EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION = Schema.decodeUnknownSync(
  PromotionGovernanceObservationSchema,
)({
  qualityAction: EXPECTED_CAPABILITY_OBSERVATION.qualityAction,
  decisionAction: EXPECTED_CAPABILITY_OBSERVATION.decisionAction,
  governanceAuditFingerprint: EXPECTED_CAPABILITY_OBSERVATION.governanceAuditFingerprint,
  activeVersion: EXPECTED_CAPABILITY_OBSERVATION.activeVersion,
});

function decodePositiveIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(PositiveIntArgumentSchema)(rawValue);
}

function decodeNonNegativeIntegerOption(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined) {
    return fallback;
  }

  return Schema.decodeUnknownSync(NonNegativeIntArgumentSchema)(rawValue);
}

function readOptionValue(args: readonly string[], index: number, option: string) {
  const rawValue = args[index + 1];

  if (rawValue === undefined || rawValue.startsWith("--")) {
    throw new Error(`Missing value for argument: ${option}`);
  }

  return rawValue;
}

export function parseOptions(args: readonly string[]) {
  let artifactPath: string | undefined;
  let baselinePath: string | undefined;
  let sampleSize = DEFAULT_SAMPLE_SIZE;
  let warmupIterations = DEFAULT_WARMUP_ITERATIONS;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--artifact") {
      artifactPath = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }

    if (argument === "--baseline") {
      baselinePath = readOptionValue(args, index, argument);
      index += 1;
      continue;
    }

    if (argument === "--sample-size") {
      sampleSize = decodePositiveIntegerOption(
        readOptionValue(args, index, argument),
        DEFAULT_SAMPLE_SIZE,
      );
      index += 1;
      continue;
    }

    if (argument === "--warmup") {
      warmupIterations = decodeNonNegativeIntegerOption(
        readOptionValue(args, index, argument),
        DEFAULT_WARMUP_ITERATIONS,
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    ...(artifactPath !== undefined ? { artifactPath: resolve(artifactPath) } : {}),
    ...(baselinePath !== undefined ? { baselinePath: resolve(baselinePath) } : {}),
    sampleSize,
    warmupIterations,
  };
}

export type BenchmarkOptions = ReturnType<typeof parseOptions>;

function percentile95(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) {
    return 0;
  }

  const position = (sorted.length - 1) * 0.95;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  const weight = position - lowerIndex;

  return lower + (upper - lower) * weight;
}

export function roundToThree(value: number) {
  return Number.parseFloat(value.toFixed(3));
}

export function summarizeMeasurements(values: readonly number[]) {
  return Schema.decodeUnknownSync(BenchmarkSummarySchema)({
    samples: values.length,
    minMs: roundToThree(Math.min(...values)),
    meanMs: roundToThree(values.reduce((total, value) => total + value, 0) / values.length),
    p95Ms: roundToThree(percentile95(values)),
    maxMs: roundToThree(Math.max(...values)),
  });
}

function packFingerprint(pack: Schema.Schema.Type<typeof SitePackSchema>) {
  return `${pack.id}:${pack.state}@${pack.version}`;
}

function clusterFingerprint(
  recommendation: Schema.Schema.Type<typeof PackReflectionRecommendationSchema>,
) {
  return recommendation.clusters
    .map(({ field, kind, occurrenceCount }) => `${field}:${kind}:${occurrenceCount}`)
    .join(">");
}

function proposalFingerprint(proposal: {
  readonly operations: ReadonlyArray<{
    readonly field: string;
    readonly action: string;
    readonly selectorCandidate: {
      readonly path: string;
    };
  }>;
}) {
  return proposal.operations
    .map(({ field, action, selectorCandidate }) => `${field}:${action}:${selectorCandidate.path}`)
    .join(">");
}

function governanceAuditFingerprint(
  governanceResult: Schema.Schema.Type<typeof PackGovernanceResultSchema>,
) {
  return governanceResult.auditTrail.map(({ auditKind }) => auditKind).join(">");
}

function observeCapabilitySlice(evidence: CapabilityEvidence) {
  return Schema.decodeUnknownSync(CapabilitySliceObservationSchema)({
    resolvedPackFingerprint: packFingerprint(evidence.resolvedPack),
    clusterFingerprint: clusterFingerprint(evidence.reflectionRecommendation),
    proposalFingerprint: proposalFingerprint(evidence.reflectionRecommendation.proposal),
    qualityAction: evidence.validationVerdict.qualityVerdict.action,
    decisionAction: evidence.automationDecision.action,
    governanceAuditFingerprint: governanceAuditFingerprint(evidence.governanceResult),
    activeVersion: evidence.governanceResult.activeArtifact?.definition.pack.version ?? "missing",
  });
}

function makePackDefinition(input: {
  readonly state: "draft" | "shadow" | "active" | "guarded" | "quarantined" | "retired";
  readonly version: string;
  readonly titleSelector: string;
}) {
  return Schema.decodeUnknownSync(SitePackDslSchema)({
    pack: {
      id: "pack-shop-example-com",
      tenantId: LOOKUP_TENANT_ID,
      domainPattern: "*.example.com",
      state: input.state,
      accessPolicyId: "policy-default",
      version: input.version,
    },
    selectors: [
      {
        field: "title",
        candidates: [
          {
            path: "title/primary",
            selector: input.titleSelector,
          },
        ],
        fallbackPolicy: {
          maxFallbackCount: 0,
          fallbackConfidenceImpact: 0,
          maxConfidenceImpact: 0,
        },
      },
      {
        field: "price",
        candidates: [
          {
            path: "price/primary",
            selector: "[data-price]",
          },
          {
            path: "price/fallback",
            selector: ".price-box",
          },
        ],
        fallbackPolicy: {
          maxFallbackCount: 1,
          fallbackConfidenceImpact: 0.15,
          maxConfidenceImpact: 0.45,
        },
      },
    ],
    assertions: {
      requiredFields: [{ field: "title" }, { field: "price" }],
      businessInvariants: [],
    },
    policy: {
      targetKinds: ["productPage"],
      mode: "http",
      render: "never",
    },
    metadata: {
      tenantId: LOOKUP_TENANT_ID,
      owners: ["team-catalog"],
      labels: ["retail"],
    },
  });
}

function makeArtifact(input: {
  readonly definition: Schema.Schema.Type<typeof SitePackDslSchema>;
  readonly recordedAt: string;
}) {
  return Schema.decodeUnknownSync(VersionedSitePackArtifactSchema)({
    definition: input.definition,
    recordedAt: input.recordedAt,
    recordedBy: "curator-main",
  });
}

function noiseVersion(index: number) {
  return `2026.02.${String((index % 28) + 1).padStart(2, "0")}.${index % 5}`;
}

function signalObservedAt(index: number, offset: number) {
  const minute = (index * 3 + offset) % 60;
  const second = (index * 7 + offset) % 60;
  return `2026-03-08T11:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
}

function buildCatalog(catalogSize: number) {
  const baseCatalog = [
    Schema.decodeUnknownSync(SitePackSchema)({
      id: "pack-shop-example-com-shadow",
      tenantId: LOOKUP_TENANT_ID,
      domainPattern: LOOKUP_DOMAIN,
      state: "shadow",
      accessPolicyId: "policy-default",
      version: "2026.03.08",
    }),
    Schema.decodeUnknownSync(SitePackSchema)({
      id: "pack-shop-example-com-active",
      tenantId: LOOKUP_TENANT_ID,
      domainPattern: LOOKUP_DOMAIN,
      state: "active",
      accessPolicyId: "policy-default",
      version: "2026.03.07",
    }),
    Schema.decodeUnknownSync(SitePackSchema)({
      id: "pack-example-com-shadow",
      tenantId: LOOKUP_TENANT_ID,
      domainPattern: "*.example.com",
      state: "shadow",
      accessPolicyId: "policy-default",
      version: "2026.03.06",
    }),
    Schema.decodeUnknownSync(SitePackSchema)({
      id: "pack-example-com-active",
      tenantId: LOOKUP_TENANT_ID,
      domainPattern: "*.example.com",
      state: "active",
      accessPolicyId: "policy-default",
      version: "2026.03.05",
    }),
  ];
  const noiseStates = ["draft", "shadow", "active", "guarded", "quarantined", "retired"] as const;
  const noiseCatalog = Array.from(
    { length: Math.max(0, catalogSize - baseCatalog.length) },
    (_, index) =>
      Schema.decodeUnknownSync(SitePackSchema)({
        id: `pack-noise-${String(index + 1).padStart(3, "0")}`,
        tenantId: index % 4 === 0 ? `tenant-noise-${index % 9}` : LOOKUP_TENANT_ID,
        domainPattern:
          index % 5 === 0
            ? "*.example.com"
            : index % 5 === 1
              ? `catalog-${index}.example.org`
              : index % 5 === 2
                ? "*.shop.example.net"
                : index % 5 === 3
                  ? "*.inventory.example.com"
                  : `edge-${index}.example.dev`,
        state: noiseStates[index % noiseStates.length],
        accessPolicyId: "policy-default",
        version: noiseVersion(index),
      }),
  );

  return [...baseCatalog, ...noiseCatalog];
}

function buildSignalBank(signalPairs: number) {
  const signals = Array.from({ length: signalPairs }, (_, index) => {
    const ordinal = String(index + 1).padStart(3, "0");

    return [
      {
        kind: "regression",
        field: "price",
        currentPrimarySelectorPath: "price/primary",
        selectorCandidate: {
          path: "price/fallback",
          selector: ".price-box",
        },
        evidenceRefs: [`artifact-regression-${ordinal}`],
        observedAt: signalObservedAt(index, 1),
      },
      {
        kind: "fixture",
        fixtureId: `fixture-title-${ordinal}`,
        field: "title",
        selectorCandidate: {
          path: "title/secondary",
          selector: "[data-title]",
        },
        evidenceRefs: [`artifact-title-${ordinal}`],
        observedAt: signalObservedAt(index, 2),
      },
    ];
  }).flat();

  return Schema.decodeUnknownSync(Schema.Array(PackCandidateSignalSchema))(signals);
}

function buildSnapshotDiff() {
  return Schema.decodeUnknownSync(SnapshotDiffSchema)({
    id: "diff-pack-shop-example-com-001",
    baselineSnapshotId: "snapshot-baseline-001",
    candidateSnapshotId: "snapshot-candidate-001",
    metrics: {
      fieldRecallDelta: 0.02,
      falsePositiveDelta: 0.01,
      driftDelta: 0.03,
      latencyDeltaMs: 30,
      memoryDelta: 4,
    },
    createdAt: "2026-03-08T11:50:00.000Z",
  });
}

export function buildBenchmarkSuite() {
  const draftDefinition = makePackDefinition({
    state: "draft",
    version: "2026.03.08",
    titleSelector: "h1.shadow",
  });
  const activeDefinition = makePackDefinition({
    state: "active",
    version: "2026.03.07",
    titleSelector: "h1.active",
  });
  const transitionedShadow = Effect.runSync(
    transitionPackLifecycle({
      pack: draftDefinition.pack,
      to: "shadow",
      changedBy: "curator-main",
      rationale: "Promote the candidate pack into the proving lane.",
      occurredAt: "2026-03-08T10:00:00.000Z",
    }).pipe(Effect.orDie),
  );
  const shadowDefinition = Schema.decodeUnknownSync(SitePackDslSchema)({
    ...draftDefinition,
    pack: transitionedShadow.pack,
  });
  const catalog = buildCatalog(WORKLOAD_PROFILE.catalogSize);
  const signals = buildSignalBank(WORKLOAD_PROFILE.signalPairs);
  const governanceCatalog = [
    makeArtifact({
      definition: activeDefinition,
      recordedAt: "2026-03-07T09:00:00.000Z",
    }),
    makeArtifact({
      definition: shadowDefinition,
      recordedAt: "2026-03-08T09:00:00.000Z",
    }),
  ];
  const profile = Schema.decodeUnknownSync(WorkloadProfileSchema)({
    catalogSize: catalog.length,
    capabilitySliceRunsPerSample: WORKLOAD_PROFILE.capabilitySliceRunsPerSample,
    registryLookupsPerSample: WORKLOAD_PROFILE.registryLookupsPerSample,
    signalCount: signals.length,
    reflectionIterationsPerSample: WORKLOAD_PROFILE.reflectionIterationsPerSample,
    governanceCatalogArtifacts: governanceCatalog.length,
    governanceIterationsPerSample: WORKLOAD_PROFILE.governanceIterationsPerSample,
    minimumOccurrenceCount: WORKLOAD_PROFILE.minimumOccurrenceCount,
  });

  return {
    activeDefinition,
    shadowDefinition,
    catalog,
    governanceCatalog,
    lookup: {
      domain: LOOKUP_DOMAIN,
      tenantId: LOOKUP_TENANT_ID,
      states: [...REGISTRY_STATES],
    },
    profile,
    signals,
    snapshotDiff: buildSnapshotDiff(),
  };
}

type BenchmarkSuite = ReturnType<typeof buildBenchmarkSuite>;

export function runCapabilitySliceObservation() {
  return runE6CapabilitySlice().pipe(Effect.map((evidence) => observeCapabilitySlice(evidence)));
}

export function runCapabilitySliceProfile(suite: BenchmarkSuite = buildBenchmarkSuite()) {
  return Effect.gen(function* () {
    let observation: CapabilitySliceObservation | undefined;

    for (
      let iteration = 0;
      iteration < suite.profile.capabilitySliceRunsPerSample;
      iteration += 1
    ) {
      observation = yield* runCapabilitySliceObservation();
    }

    return observation ?? EXPECTED_CAPABILITY_OBSERVATION;
  });
}

export function runRegistryResolutionProfile(suite: BenchmarkSuite = buildBenchmarkSuite()) {
  return Effect.sync(() => {
    let resolved = resolvePackRegistryLookup(suite.catalog, suite.lookup);

    for (let iteration = 1; iteration < suite.profile.registryLookupsPerSample; iteration += 1) {
      resolved = resolvePackRegistryLookup(suite.catalog, suite.lookup);
    }

    return resolved;
  }).pipe(
    Effect.flatMap((candidate) =>
      Option.match(candidate, {
        onNone: () =>
          Effect.fail(new Error("Expected E6 benchmark registry lookup to resolve a pack.")),
        onSome: (pack) =>
          Effect.succeed(
            Schema.decodeUnknownSync(RegistryResolutionObservationSchema)({
              resolvedPackFingerprint: packFingerprint(pack),
            }),
          ),
      }),
    ),
  );
}

export function runReflectionRecommendationProfile(suite: BenchmarkSuite = buildBenchmarkSuite()) {
  return Effect.gen(function* () {
    let observation: ReflectionRecommendationObservation | undefined;

    for (
      let iteration = 0;
      iteration < suite.profile.reflectionIterationsPerSample;
      iteration += 1
    ) {
      const recommendation = yield* synthesizePackReflection({
        pack: suite.shadowDefinition,
        signals: suite.signals,
        createdAt: CREATED_AT,
        minimumOccurrenceCount: suite.profile.minimumOccurrenceCount,
      });

      observation = Schema.decodeUnknownSync(ReflectionRecommendationObservationSchema)({
        clusterFingerprint: clusterFingerprint(recommendation),
        proposalFingerprint: proposalFingerprint(recommendation.proposal),
      });
    }

    return (
      observation ??
      Schema.decodeUnknownSync(ReflectionRecommendationObservationSchema)({
        clusterFingerprint: "missing",
        proposalFingerprint: "missing",
      })
    );
  });
}

export function runPromotionGovernanceProfile(suite: BenchmarkSuite = buildBenchmarkSuite()) {
  return Effect.gen(function* () {
    let observation: PromotionGovernanceObservation | undefined;

    for (
      let iteration = 0;
      iteration < suite.profile.governanceIterationsPerSample;
      iteration += 1
    ) {
      const validationVerdict = yield* evaluateValidatorLadder({
        pack: suite.shadowDefinition.pack,
        snapshotDiff: suite.snapshotDiff,
        checks: {
          replayDeterminism: true,
          workflowResume: true,
          canary: true,
          chaos: true,
          securityRedaction: true,
          soakStability: true,
        },
        createdAt: "2026-03-08T12:05:00.000Z",
      });
      const decision = yield* decidePackPromotion({
        pack: suite.shadowDefinition.pack,
        verdict: validationVerdict.qualityVerdict,
      });
      const governanceResult = yield* applyPackGovernanceDecision({
        catalog: suite.governanceCatalog,
        subjectPackId: suite.shadowDefinition.pack.id,
        subjectPackVersion: suite.shadowDefinition.pack.version,
        decision,
        changedBy: "curator-main",
        rationale: "Shadow candidate cleared the full validator ladder.",
        occurredAt: "2026-03-08T12:10:00.000Z",
        nextVersion: GOVERNANCE_NEXT_VERSION,
      });

      observation = Schema.decodeUnknownSync(PromotionGovernanceObservationSchema)({
        qualityAction: validationVerdict.qualityVerdict.action,
        decisionAction: decision.action,
        governanceAuditFingerprint: governanceAuditFingerprint(governanceResult),
        activeVersion: governanceResult.activeArtifact?.definition.pack.version ?? "missing",
      });
    }

    return (
      observation ??
      Schema.decodeUnknownSync(PromotionGovernanceObservationSchema)({
        qualityAction: "missing",
        decisionAction: "missing",
        governanceAuditFingerprint: "missing",
        activeVersion: "missing",
      })
    );
  });
}

async function measureEffectWithOutputs<A>(
  sampleSize: number,
  warmupIterations: number,
  effectFactory: () => Effect.Effect<A, unknown, never>,
  sampleNormalization = 1,
) {
  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    await Effect.runPromise(effectFactory().pipe(Effect.orDie));
  }

  const values = new Array<number>();
  const outputs = new Array<A>();

  for (let iteration = 0; iteration < sampleSize; iteration += 1) {
    const startedAt = performance.now();
    const output = await Effect.runPromise(effectFactory().pipe(Effect.orDie));
    values.push((performance.now() - startedAt) / sampleNormalization);
    outputs.push(output);
  }

  return {
    outputs,
    summary: summarizeMeasurements(values),
  };
}

function buildStabilityField<Observation>(
  expected: string,
  observations: ReadonlyArray<Observation>,
  select: (observation: Observation) => string,
) {
  const observed = observations.at(-1);

  return Schema.decodeUnknownSync(StabilityFieldSchema)({
    expected,
    observed: observed === undefined ? expected : select(observed),
    consistent: observations.every((observation) => select(observation) === expected),
  });
}

function sameWorkloadProfile(left: WorkloadProfile, right: WorkloadProfile) {
  return (
    left.catalogSize === right.catalogSize &&
    left.capabilitySliceRunsPerSample === right.capabilitySliceRunsPerSample &&
    left.registryLookupsPerSample === right.registryLookupsPerSample &&
    left.signalCount === right.signalCount &&
    left.reflectionIterationsPerSample === right.reflectionIterationsPerSample &&
    left.governanceCatalogArtifacts === right.governanceCatalogArtifacts &&
    left.governanceIterationsPerSample === right.governanceIterationsPerSample &&
    left.minimumOccurrenceCount === right.minimumOccurrenceCount
  );
}

function buildIncompatibleBaselineReason(
  options: Pick<BenchmarkArtifact, "sampleSize" | "warmupIterations">,
  profile: WorkloadProfile,
  baseline: BenchmarkArtifact,
) {
  if (baseline.sampleSize !== options.sampleSize) {
    return `Expected baseline sampleSize ${options.sampleSize}, received ${baseline.sampleSize}.`;
  }

  if (baseline.warmupIterations !== options.warmupIterations) {
    return `Expected baseline warmupIterations ${options.warmupIterations}, received ${baseline.warmupIterations}.`;
  }

  if (!sameWorkloadProfile(baseline.profile, profile)) {
    return "Expected the baseline workload profile to match the current benchmark workload profile.";
  }

  return null;
}

function buildComparison(
  options: Pick<BenchmarkArtifact, "sampleSize" | "warmupIterations"> & { baselinePath?: string },
  profile: WorkloadProfile,
  measurements: BenchmarkArtifact["measurements"],
  baseline: BenchmarkArtifact | undefined,
) {
  const incompatibleReason =
    baseline === undefined ? null : buildIncompatibleBaselineReason(options, profile, baseline);
  const comparable = baseline !== undefined && incompatibleReason === null;

  return Schema.decodeUnknownSync(BenchmarkArtifactSchema.fields.comparison)({
    baselinePath: options.baselinePath ?? null,
    comparable,
    incompatibleReason,
    deltas: {
      capabilitySliceP95Ms: comparable
        ? roundToThree(
            measurements.capabilitySlice.p95Ms - baseline.measurements.capabilitySlice.p95Ms,
          )
        : null,
      registryResolutionP95Ms: comparable
        ? roundToThree(
            measurements.registryResolution.p95Ms - baseline.measurements.registryResolution.p95Ms,
          )
        : null,
      reflectionRecommendationP95Ms: comparable
        ? roundToThree(
            measurements.reflectionRecommendation.p95Ms -
              baseline.measurements.reflectionRecommendation.p95Ms,
          )
        : null,
      promotionGovernanceP95Ms: comparable
        ? roundToThree(
            measurements.promotionGovernance.p95Ms -
              baseline.measurements.promotionGovernance.p95Ms,
          )
        : null,
      heapDeltaKiB: comparable
        ? roundToThree(measurements.heapDeltaKiB - baseline.measurements.heapDeltaKiB)
        : null,
    },
  });
}

export function buildStability(input: {
  readonly capabilitySlice: ReadonlyArray<CapabilitySliceObservation>;
  readonly registryResolution: ReadonlyArray<RegistryResolutionObservation>;
  readonly reflectionRecommendation: ReadonlyArray<ReflectionRecommendationObservation>;
  readonly promotionGovernance: ReadonlyArray<PromotionGovernanceObservation>;
}) {
  return Schema.decodeUnknownSync(BenchmarkStabilitySchema)({
    resolvedPackFingerprint: buildStabilityField(
      EXPECTED_CAPABILITY_OBSERVATION.resolvedPackFingerprint,
      input.capabilitySlice,
      (observation) => observation.resolvedPackFingerprint,
    ),
    clusterFingerprint: buildStabilityField(
      EXPECTED_CAPABILITY_OBSERVATION.clusterFingerprint,
      input.capabilitySlice,
      (observation) => observation.clusterFingerprint,
    ),
    proposalFingerprint: buildStabilityField(
      EXPECTED_CAPABILITY_OBSERVATION.proposalFingerprint,
      input.capabilitySlice,
      (observation) => observation.proposalFingerprint,
    ),
    qualityAction: buildStabilityField(
      EXPECTED_CAPABILITY_OBSERVATION.qualityAction,
      input.capabilitySlice,
      (observation) => observation.qualityAction,
    ),
    decisionAction: buildStabilityField(
      EXPECTED_CAPABILITY_OBSERVATION.decisionAction,
      input.capabilitySlice,
      (observation) => observation.decisionAction,
    ),
    governanceAuditFingerprint: buildStabilityField(
      EXPECTED_CAPABILITY_OBSERVATION.governanceAuditFingerprint,
      input.capabilitySlice,
      (observation) => observation.governanceAuditFingerprint,
    ),
    activeVersion: buildStabilityField(
      EXPECTED_CAPABILITY_OBSERVATION.activeVersion,
      input.capabilitySlice,
      (observation) => observation.activeVersion,
    ),
    registryResolvedPackFingerprint: buildStabilityField(
      EXPECTED_REGISTRY_RESOLUTION_OBSERVATION.resolvedPackFingerprint,
      input.registryResolution,
      (observation) => observation.resolvedPackFingerprint,
    ),
    reflectionClusterFingerprint: buildStabilityField(
      EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION.clusterFingerprint,
      input.reflectionRecommendation,
      (observation) => observation.clusterFingerprint,
    ),
    reflectionProposalFingerprint: buildStabilityField(
      EXPECTED_REFLECTION_RECOMMENDATION_OBSERVATION.proposalFingerprint,
      input.reflectionRecommendation,
      (observation) => observation.proposalFingerprint,
    ),
    promotionQualityAction: buildStabilityField(
      EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION.qualityAction,
      input.promotionGovernance,
      (observation) => observation.qualityAction,
    ),
    promotionDecisionAction: buildStabilityField(
      EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION.decisionAction,
      input.promotionGovernance,
      (observation) => observation.decisionAction,
    ),
    promotionGovernanceAuditFingerprint: buildStabilityField(
      EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION.governanceAuditFingerprint,
      input.promotionGovernance,
      (observation) => observation.governanceAuditFingerprint,
    ),
    promotionActiveVersion: buildStabilityField(
      EXPECTED_PROMOTION_GOVERNANCE_OBSERVATION.activeVersion,
      input.promotionGovernance,
      (observation) => observation.activeVersion,
    ),
  });
}

function collectViolations(
  measurements: BenchmarkArtifact["measurements"],
  stability: BenchmarkStability,
) {
  const violations = new Array<string>();

  if (measurements.capabilitySlice.p95Ms > PERFORMANCE_BUDGETS.capabilitySliceP95Ms) {
    violations.push(
      `Expected E6 capability-slice p95 <= ${PERFORMANCE_BUDGETS.capabilitySliceP95Ms}ms, received ${measurements.capabilitySlice.p95Ms}ms.`,
    );
  }

  if (measurements.registryResolution.p95Ms > PERFORMANCE_BUDGETS.registryResolutionP95Ms) {
    violations.push(
      `Expected E6 registry-resolution p95 <= ${PERFORMANCE_BUDGETS.registryResolutionP95Ms}ms, received ${measurements.registryResolution.p95Ms}ms.`,
    );
  }

  if (
    measurements.reflectionRecommendation.p95Ms > PERFORMANCE_BUDGETS.reflectionRecommendationP95Ms
  ) {
    violations.push(
      `Expected E6 reflection-recommendation p95 <= ${PERFORMANCE_BUDGETS.reflectionRecommendationP95Ms}ms, received ${measurements.reflectionRecommendation.p95Ms}ms.`,
    );
  }

  if (measurements.promotionGovernance.p95Ms > PERFORMANCE_BUDGETS.promotionGovernanceP95Ms) {
    violations.push(
      `Expected E6 promotion-governance p95 <= ${PERFORMANCE_BUDGETS.promotionGovernanceP95Ms}ms, received ${measurements.promotionGovernance.p95Ms}ms.`,
    );
  }

  if (measurements.heapDeltaKiB > PERFORMANCE_BUDGETS.heapDeltaKiB) {
    violations.push(
      `Expected heap delta <= ${PERFORMANCE_BUDGETS.heapDeltaKiB} KiB, received ${measurements.heapDeltaKiB} KiB.`,
    );
  }

  for (const [fieldName, field] of Object.entries(stability)) {
    if (!field.consistent) {
      violations.push(
        `Expected E6 ${fieldName} to remain ${field.expected}, received ${field.observed}.`,
      );
    }
  }

  return violations;
}

export function buildArtifact(
  options: BenchmarkOptions,
  profile: WorkloadProfile,
  measurements: BenchmarkArtifact["measurements"],
  stability: BenchmarkStability,
  baseline: BenchmarkArtifact | undefined,
) {
  const violations = collectViolations(measurements, stability);

  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)({
    benchmark: "e6-performance-budget",
    generatedAt: new Date().toISOString(),
    environment: {
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    },
    sampleSize: options.sampleSize,
    warmupIterations: options.warmupIterations,
    profile,
    budgets: PERFORMANCE_BUDGETS,
    measurements,
    stability,
    comparison: buildComparison(options, profile, measurements, baseline),
    violations,
    status: violations.length === 0 ? "pass" : "fail",
  });
}

async function readBaseline(path: string | undefined) {
  if (path === undefined) {
    return undefined;
  }

  const baseline = await readFile(path, "utf8");
  return Schema.decodeUnknownSync(BenchmarkArtifactSchema)(JSON.parse(baseline));
}

export async function writeArtifact(path: string | undefined, artifact: unknown) {
  if (path === undefined) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function collectMeasurements(options: BenchmarkOptions) {
  const suite = buildBenchmarkSuite();
  const heapStart = process.memoryUsage().heapUsed;
  const capabilitySlice = await measureEffectWithOutputs(
    options.sampleSize,
    options.warmupIterations,
    () => runCapabilitySliceProfile(suite),
    suite.profile.capabilitySliceRunsPerSample,
  );
  const registryResolution = await measureEffectWithOutputs(
    options.sampleSize,
    options.warmupIterations,
    () => runRegistryResolutionProfile(suite),
  );
  const reflectionRecommendation = await measureEffectWithOutputs(
    options.sampleSize,
    options.warmupIterations,
    () => runReflectionRecommendationProfile(suite),
  );
  const promotionGovernance = await measureEffectWithOutputs(
    options.sampleSize,
    options.warmupIterations,
    () => runPromotionGovernanceProfile(suite),
  );
  const heapDeltaKiB = roundToThree((process.memoryUsage().heapUsed - heapStart) / 1_024);

  return {
    profile: suite.profile,
    stability: buildStability({
      capabilitySlice: capabilitySlice.outputs,
      registryResolution: registryResolution.outputs,
      reflectionRecommendation: reflectionRecommendation.outputs,
      promotionGovernance: promotionGovernance.outputs,
    }),
    measurements: {
      capabilitySlice: capabilitySlice.summary,
      registryResolution: registryResolution.summary,
      reflectionRecommendation: reflectionRecommendation.summary,
      promotionGovernance: promotionGovernance.summary,
      heapDeltaKiB,
    },
  };
}

export async function runBenchmark(args: readonly string[] = Bun.argv.slice(2)) {
  const options = parseOptions(args);
  const baseline = await readBaseline(options.baselinePath);
  const { profile, measurements, stability } = await collectMeasurements(options);
  const artifact = buildArtifact(options, profile, measurements, stability, baseline);

  await writeArtifact(options.artifactPath, artifact);

  return artifact;
}

async function main() {
  const artifact = await runBenchmark(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  if (artifact.status === "fail") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
