import { Effect, Layer, Schema } from "effect";
import { SnapshotDiffChangeSchema, SnapshotDiffSchema } from "./diff-verdict.ts";
import { ObservationSchema, SnapshotSchema } from "./observation-snapshot.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { DiffEngine } from "./service-topology.ts";
import { DriftDetected } from "./tagged-errors.ts";

const BOUNDED_SCORE_SCHEMA = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
  Schema.isLessThanOrEqualTo(1),
);

type Snapshot = Schema.Schema.Type<typeof SnapshotSchema>;
type Observation = Schema.Schema.Type<typeof ObservationSchema>;
type SnapshotDiffChange = Schema.Schema.Type<typeof SnapshotDiffChangeSchema>;

export class CanonicalSnapshotField extends Schema.Class<CanonicalSnapshotField>(
  "CanonicalSnapshotField",
)({
  field: Schema.Trim.check(Schema.isNonEmpty()),
  observation: ObservationSchema,
  valueFingerprint: Schema.String,
}) {}

const CanonicalSnapshotFieldsSchema = Schema.Array(CanonicalSnapshotField).pipe(
  Schema.refine(
    (fields): fields is ReadonlyArray<CanonicalSnapshotField> =>
      new Set(fields.map(({ field }) => field)).size === fields.length,
    {
      message: "Expected canonical snapshot fields keyed by unique field names.",
    },
  ),
);

export class CanonicalSnapshot extends Schema.Class<CanonicalSnapshot>("CanonicalSnapshot")({
  snapshotId: CanonicalIdentifierSchema,
  targetId: CanonicalIdentifierSchema,
  qualityScore: BOUNDED_SCORE_SCHEMA,
  confidenceScore: BOUNDED_SCORE_SCHEMA,
  fields: CanonicalSnapshotFieldsSchema,
}) {}

export const CanonicalSnapshotFieldSchema = CanonicalSnapshotField;
export const CanonicalSnapshotSchema = CanonicalSnapshot;

export const SnapshotDiffEngineInputSchema = Schema.Struct({
  id: CanonicalIdentifierSchema,
  baseline: SnapshotSchema,
  candidate: SnapshotSchema,
  createdAt: IsoDateTimeSchema,
  latencyDeltaMs: Schema.optional(Schema.Int),
  memoryDelta: Schema.optional(Schema.Finite),
});

function roundMetric(value: number) {
  return Number(value.toFixed(6));
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    if (Object.prototype.toString.call(value) === "[object Date]") {
      return JSON.stringify(value);
    }

    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(Reflect.get(value, key))}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function canonicalEvidenceRefs(evidenceRefs: ReadonlyArray<string>) {
  return [...evidenceRefs].sort((left, right) => left.localeCompare(right));
}

function normalizeObservation(observation: Observation) {
  return Schema.decodeUnknownSync(ObservationSchema)({
    field: observation.field,
    normalizedValue: observation.normalizedValue,
    confidence: observation.confidence,
    evidenceRefs: canonicalEvidenceRefs(observation.evidenceRefs),
  });
}

function compareObservationCandidates(left: Observation, right: Observation) {
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }

  const leftValue = stableSerialize(left.normalizedValue);
  const rightValue = stableSerialize(right.normalizedValue);
  if (leftValue !== rightValue) {
    return leftValue.localeCompare(rightValue);
  }

  return canonicalEvidenceRefs(left.evidenceRefs)
    .join("|")
    .localeCompare(canonicalEvidenceRefs(right.evidenceRefs).join("|"));
}

function averageConfidence(fields: ReadonlyArray<CanonicalSnapshotField>, fallback: number) {
  if (fields.length === 0) {
    return roundMetric(fallback);
  }

  const total = fields.reduce((sum, field) => sum + field.observation.confidence, 0);
  return roundMetric(total / fields.length);
}

function sumConfidence(fields: ReadonlyArray<CanonicalSnapshotField>) {
  return fields.reduce((sum, field) => sum + field.observation.confidence, 0);
}

function decodeSnapshot(input: unknown, message: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(SnapshotSchema)(input),
    catch: () => new DriftDetected({ message }),
  });
}

function buildCanonicalSnapshot(decoded: Snapshot) {
  const observationsByField = new Map<string, ReadonlyArray<Observation>>();

  for (const observation of decoded.observations) {
    const current = observationsByField.get(observation.field);
    observationsByField.set(
      observation.field,
      current === undefined ? [observation] : [...current, observation],
    );
  }

  const fields = Array.from(observationsByField.entries())
    .sort(([leftField], [rightField]) => leftField.localeCompare(rightField))
    .map(([, observations]) => {
      const [bestObservation] = [...observations].sort(compareObservationCandidates);
      if (bestObservation === undefined) {
        throw new DriftDetected({
          message: "Canonical snapshot construction expected at least one observation per field.",
        });
      }

      const observation = normalizeObservation(bestObservation);
      return Schema.decodeUnknownSync(CanonicalSnapshotFieldSchema)({
        field: observation.field,
        observation,
        valueFingerprint: stableSerialize(observation.normalizedValue),
      });
    });

  return Schema.decodeUnknownSync(CanonicalSnapshotSchema)({
    snapshotId: decoded.id,
    targetId: decoded.targetId,
    qualityScore: decoded.qualityScore,
    confidenceScore: averageConfidence(fields, decoded.qualityScore),
    fields,
  });
}

function buildFieldIndex(fields: ReadonlyArray<CanonicalSnapshotField>) {
  return new Map(fields.map((field) => [field.field, field] as const));
}

function safeRate(numerator: number, denominator: number) {
  if (denominator === 0) {
    return 0;
  }

  return roundMetric(numerator / denominator);
}

function buildChange(
  field: string,
  baselineField: CanonicalSnapshotField | undefined,
  candidateField: CanonicalSnapshotField | undefined,
) {
  if (baselineField === undefined && candidateField !== undefined) {
    return Schema.decodeUnknownSync(SnapshotDiffChangeSchema)({
      changeType: "add",
      field,
      candidate: candidateField.observation,
      confidenceDelta: roundMetric(candidateField.observation.confidence),
    });
  }

  if (baselineField !== undefined && candidateField === undefined) {
    return Schema.decodeUnknownSync(SnapshotDiffChangeSchema)({
      changeType: "remove",
      field,
      baseline: baselineField.observation,
      confidenceDelta: roundMetric(-baselineField.observation.confidence),
    });
  }

  if (
    baselineField !== undefined &&
    candidateField !== undefined &&
    baselineField.valueFingerprint !== candidateField.valueFingerprint
  ) {
    return Schema.decodeUnknownSync(SnapshotDiffChangeSchema)({
      changeType: "change",
      field,
      baseline: baselineField.observation,
      candidate: candidateField.observation,
      confidenceDelta: roundMetric(
        candidateField.observation.confidence - baselineField.observation.confidence,
      ),
    });
  }

  return undefined;
}

export function canonicalizeSnapshot(input: unknown) {
  return Effect.gen(function* () {
    const snapshot = yield* decodeSnapshot(
      input,
      "Failed to decode snapshot input through shared contracts.",
    );
    return buildCanonicalSnapshot(snapshot);
  });
}

export function compareSnapshots(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(SnapshotDiffEngineInputSchema)(input),
      catch: () =>
        new DriftDetected({
          message: "Failed to decode snapshot diff input through shared contracts.",
        }),
    });

    if (decoded.baseline.targetId !== decoded.candidate.targetId) {
      return yield* Effect.fail(
        new DriftDetected({
          message: "Snapshot diff requires baseline and candidate snapshots for the same target.",
        }),
      );
    }

    const baselineCanonical = buildCanonicalSnapshot(decoded.baseline);
    const candidateCanonical = buildCanonicalSnapshot(decoded.candidate);
    const baselineFieldIndex = buildFieldIndex(baselineCanonical.fields);
    const candidateFieldIndex = buildFieldIndex(candidateCanonical.fields);
    const fieldNames = Array.from(
      new Set([...baselineFieldIndex.keys(), ...candidateFieldIndex.keys()]),
    ).sort((left, right) => left.localeCompare(right));

    let unchangedFieldCount = 0;
    let addedFieldCount = 0;
    let removedFieldCount = 0;
    let changedFieldCount = 0;
    let retainedBaselineConfidence = 0;
    let addedCandidateConfidence = 0;
    let removedBaselineConfidence = 0;
    let changedConfidenceWeight = 0;
    const changes: Array<SnapshotDiffChange> = [];

    for (const field of fieldNames) {
      const baselineField = baselineFieldIndex.get(field);
      const candidateField = candidateFieldIndex.get(field);
      const change = buildChange(field, baselineField, candidateField);

      if (change === undefined) {
        if (baselineField !== undefined) {
          unchangedFieldCount += 1;
          retainedBaselineConfidence += baselineField.observation.confidence;
        }

        continue;
      }

      changes.push(change);
      if (change.changeType === "add") {
        addedFieldCount += 1;
        addedCandidateConfidence += change.candidate.confidence;
        continue;
      }

      if (change.changeType === "remove") {
        removedFieldCount += 1;
        removedBaselineConfidence += change.baseline.confidence;
        continue;
      }

      changedFieldCount += 1;
      changedConfidenceWeight += (change.baseline.confidence + change.candidate.confidence) / 2;
    }

    const baselineConfidenceTotal = sumConfidence(baselineCanonical.fields);
    const candidateConfidenceTotal = sumConfidence(candidateCanonical.fields);

    return Schema.decodeUnknownSync(SnapshotDiffSchema)({
      id: decoded.id,
      baselineSnapshotId: decoded.baseline.id,
      candidateSnapshotId: decoded.candidate.id,
      metrics: {
        fieldRecallDelta: safeRate(
          retainedBaselineConfidence - baselineConfidenceTotal,
          baselineConfidenceTotal,
        ),
        falsePositiveDelta: safeRate(-addedCandidateConfidence, candidateConfidenceTotal),
        driftDelta: safeRate(
          -(removedBaselineConfidence + addedCandidateConfidence + changedConfidenceWeight),
          baselineConfidenceTotal + candidateConfidenceTotal,
        ),
        latencyDeltaMs: decoded.latencyDeltaMs ?? 0,
        memoryDelta: decoded.memoryDelta ?? 0,
      },
      changes,
      canonicalMetrics: {
        baselineFieldCount: baselineCanonical.fields.length,
        candidateFieldCount: candidateCanonical.fields.length,
        unchangedFieldCount,
        addedFieldCount,
        removedFieldCount,
        changedFieldCount,
        baselineConfidenceScore: baselineCanonical.confidenceScore,
        candidateConfidenceScore: candidateCanonical.confidenceScore,
        confidenceDelta: roundMetric(
          candidateCanonical.confidenceScore - baselineCanonical.confidenceScore,
        ),
      },
      createdAt: decoded.createdAt,
    });
  });
}

type DiffIdentifierFactory = (baseline: Snapshot, candidate: Snapshot) => string;

export function makeSnapshotDiffEngine(
  now: () => Date = () => new Date(),
  createDiffId: DiffIdentifierFactory = (baseline, candidate) =>
    `diff-${baseline.id}-${candidate.id}`,
) {
  const compare = Effect.fn("SnapshotDiffEngineLive.compare")(function* (
    baseline: Snapshot,
    candidate: Snapshot,
  ) {
    return yield* compareSnapshots({
      id: createDiffId(baseline, candidate),
      baseline,
      candidate,
      createdAt: now().toISOString(),
      latencyDeltaMs: 0,
      memoryDelta: 0,
    });
  });

  return DiffEngine.of({ compare });
}

export function SnapshotDiffEngineLive(
  now: () => Date = () => new Date(),
  createDiffId: DiffIdentifierFactory = (baseline, candidate) =>
    `diff-${baseline.id}-${candidate.id}`,
) {
  return Layer.succeed(DiffEngine)(makeSnapshotDiffEngine(now, createDiffId));
}
