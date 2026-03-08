import { Effect, Schema } from "effect";
import { PackPromotionDecisionSchema } from "./diff-verdict.ts";
import { transitionPackLifecycle } from "./pack-lifecycle-runtime.ts";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import {
  PackStateSchema,
  PackVersionSchema,
  SitePackDslSchema,
  comparePackVersions,
  type PackState,
  type PackVersion,
  type SitePackDsl,
} from "./site-pack.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const NonEmptyMessageSchema = Schema.Trim.check(Schema.isNonEmpty());
const PackGovernanceAuditKindSchema = Schema.Literals([
  "transition",
  "activate-version",
  "demote-previous-active",
] as const);

export class VersionedSitePackArtifact extends Schema.Class<VersionedSitePackArtifact>(
  "VersionedSitePackArtifact",
)({
  definition: SitePackDslSchema,
  recordedAt: IsoDateTimeSchema,
  recordedBy: CanonicalIdentifierSchema,
  sourceDecisionId: Schema.optional(CanonicalIdentifierSchema),
  derivedFromVersion: Schema.optional(PackVersionSchema),
  replacedActiveVersion: Schema.optional(PackVersionSchema),
  lastGovernedAt: Schema.optional(IsoDateTimeSchema),
  lastGovernedBy: Schema.optional(CanonicalIdentifierSchema),
}) {}

export const VersionedSitePackArtifactSchema = VersionedSitePackArtifact;

export const VersionedSitePackCatalogSchema = Schema.Array(VersionedSitePackArtifactSchema).pipe(
  Schema.refine(
    (artifacts): artifacts is ReadonlyArray<VersionedSitePackArtifact> =>
      new Set(artifacts.map(({ definition }) => `${definition.pack.id}:${definition.pack.version}`))
        .size === artifacts.length,
    {
      message: "Expected unique pack artifact versions for each pack id in the governance catalog.",
    },
  ),
  Schema.refine(
    (artifacts): artifacts is ReadonlyArray<VersionedSitePackArtifact> =>
      Array.from(
        artifacts
          .reduce((counts, artifact) => {
            const packId = artifact.definition.pack.id;
            const nextCount =
              artifact.definition.pack.state === "active"
                ? (counts.get(packId) ?? 0) + 1
                : (counts.get(packId) ?? 0);
            counts.set(packId, nextCount);
            return counts;
          }, new Map<string, number>())
          .values(),
      ).every((count) => count <= 1),
    {
      message: "Expected at most one active pack artifact per pack id in the governance catalog.",
    },
  ),
);

export class PackGovernanceRequest extends Schema.Class<PackGovernanceRequest>(
  "PackGovernanceRequest",
)({
  catalog: VersionedSitePackCatalogSchema,
  subjectPackId: CanonicalIdentifierSchema,
  subjectPackVersion: PackVersionSchema,
  decision: PackPromotionDecisionSchema,
  changedBy: CanonicalIdentifierSchema,
  rationale: NonEmptyMessageSchema,
  occurredAt: IsoDateTimeSchema,
  nextVersion: Schema.optional(PackVersionSchema),
}) {}

export class PackGovernanceAuditRecord extends Schema.Class<PackGovernanceAuditRecord>(
  "PackGovernanceAuditRecord",
)({
  id: CanonicalIdentifierSchema,
  decisionId: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  auditKind: PackGovernanceAuditKindSchema,
  triggerVerdictId: CanonicalIdentifierSchema,
  sourceVersion: PackVersionSchema,
  sourceState: PackStateSchema,
  targetVersion: PackVersionSchema,
  targetState: PackStateSchema,
  changedBy: CanonicalIdentifierSchema,
  rationale: NonEmptyMessageSchema,
  occurredAt: IsoDateTimeSchema,
}) {}

const AuditTrailSchema = Schema.Array(PackGovernanceAuditRecord).pipe(
  Schema.refine(
    (auditTrail): auditTrail is ReadonlyArray<PackGovernanceAuditRecord> =>
      auditTrail.length > 0 && new Set(auditTrail.map(({ id }) => id)).size === auditTrail.length,
    {
      message: "Expected governance results to emit a non-empty audit trail with unique ids.",
    },
  ),
);

export class PackGovernanceResult extends Schema.Class<PackGovernanceResult>(
  "PackGovernanceResult",
)({
  catalog: VersionedSitePackCatalogSchema,
  activeArtifact: Schema.optional(VersionedSitePackArtifactSchema),
  auditTrail: AuditTrailSchema,
}) {}

export const PackGovernanceRequestSchema = PackGovernanceRequest;
export const PackGovernanceAuditRecordSchema = PackGovernanceAuditRecord;
export const PackGovernanceResultSchema = PackGovernanceResult;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function artifactKey(artifact: VersionedSitePackArtifact) {
  return `${artifact.definition.pack.id}:${artifact.definition.pack.version}`;
}

function auditId(
  decisionId: string,
  auditKind: Schema.Schema.Type<typeof PackGovernanceAuditKindSchema>,
  sourceVersion: string,
  targetVersion: string,
  occurredAt: string,
) {
  return `pack-governance-${decisionId}-${auditKind}-${sourceVersion}-${targetVersion}-${occurredAt}`;
}

function buildAuditRecord(input: {
  decision: Schema.Schema.Type<typeof PackPromotionDecisionSchema>;
  auditKind: Schema.Schema.Type<typeof PackGovernanceAuditKindSchema>;
  packId: string;
  sourceVersion: PackVersion;
  sourceState: PackState;
  targetVersion: PackVersion;
  targetState: PackState;
  changedBy: string;
  rationale: string;
  occurredAt: string;
}) {
  return Schema.decodeUnknownSync(PackGovernanceAuditRecordSchema)({
    id: auditId(
      input.decision.id,
      input.auditKind,
      input.sourceVersion,
      input.targetVersion,
      input.occurredAt,
    ),
    decisionId: input.decision.id,
    packId: input.packId,
    auditKind: input.auditKind,
    triggerVerdictId: input.decision.triggerVerdictId,
    sourceVersion: input.sourceVersion,
    sourceState: input.sourceState,
    targetVersion: input.targetVersion,
    targetState: input.targetState,
    changedBy: input.changedBy,
    rationale: input.rationale,
    occurredAt: input.occurredAt,
  });
}

function replaceArtifact(
  catalog: ReadonlyArray<VersionedSitePackArtifact>,
  nextArtifact: VersionedSitePackArtifact,
) {
  return catalog.map((artifact) =>
    artifactKey(artifact) === artifactKey(nextArtifact) ? nextArtifact : artifact,
  );
}

function buildTransitionedArtifact(
  artifact: VersionedSitePackArtifact,
  nextDefinition: SitePackDsl,
  occurredAt: string,
  changedBy: string,
) {
  return Schema.decodeUnknownSync(VersionedSitePackArtifactSchema)({
    ...artifact,
    definition: nextDefinition,
    lastGovernedAt: occurredAt,
    lastGovernedBy: changedBy,
  });
}

function buildActivatedArtifact(input: {
  artifact: VersionedSitePackArtifact;
  nextVersion: PackVersion;
  changedBy: string;
  occurredAt: string;
  sourceDecisionId: string;
  replacedActiveVersion: PackVersion | undefined;
}) {
  return Schema.decodeUnknownSync(VersionedSitePackArtifactSchema)({
    definition: {
      ...input.artifact.definition,
      pack: {
        ...input.artifact.definition.pack,
        state: "active",
        version: input.nextVersion,
      },
    },
    recordedAt: input.occurredAt,
    recordedBy: input.changedBy,
    sourceDecisionId: input.sourceDecisionId,
    derivedFromVersion: input.artifact.definition.pack.version,
    replacedActiveVersion: input.replacedActiveVersion,
    lastGovernedAt: input.occurredAt,
    lastGovernedBy: input.changedBy,
  });
}

function findArtifact(
  catalog: ReadonlyArray<VersionedSitePackArtifact>,
  packId: string,
  version: string,
) {
  return catalog.find(
    (artifact) =>
      artifact.definition.pack.id === packId && artifact.definition.pack.version === version,
  );
}

function findActiveArtifact(catalog: ReadonlyArray<VersionedSitePackArtifact>, packId: string) {
  return catalog.find(
    (artifact) =>
      artifact.definition.pack.id === packId && artifact.definition.pack.state === "active",
  );
}

function newestVersionForPack(catalog: ReadonlyArray<VersionedSitePackArtifact>, packId: string) {
  return catalog
    .filter((artifact) => artifact.definition.pack.id === packId)
    .map((artifact) => artifact.definition.pack.version)
    .sort((left, right) => comparePackVersions(right, left))[0];
}

function ensureDecisionMatchesSubject(input: {
  subjectArtifact: VersionedSitePackArtifact;
  subjectPackId: string;
  subjectPackVersion: string;
  decision: Schema.Schema.Type<typeof PackPromotionDecisionSchema>;
}) {
  if (input.decision.packId !== input.subjectPackId) {
    return Effect.fail(
      new PolicyViolation({
        message:
          "Expected the curator decision pack id to match the explicitly selected pack artifact.",
      }),
    );
  }

  if (input.subjectArtifact.definition.pack.id !== input.subjectPackId) {
    return Effect.fail(
      new PolicyViolation({
        message: "Expected the selected pack artifact to match the requested pack id.",
      }),
    );
  }

  if (input.subjectArtifact.definition.pack.version !== input.subjectPackVersion) {
    return Effect.fail(
      new PolicyViolation({
        message: "Expected the selected pack artifact to match the requested pack version.",
      }),
    );
  }

  if (input.subjectArtifact.definition.pack.state !== input.decision.fromState) {
    return Effect.fail(
      new PolicyViolation({
        message:
          "Expected the curator decision source state to match the selected pack artifact state.",
      }),
    );
  }

  return Effect.void;
}

function ensureNextVersion(input: {
  catalog: ReadonlyArray<VersionedSitePackArtifact>;
  packId: string;
  sourceVersion: string;
  nextVersion: string | undefined;
}) {
  if (input.nextVersion === undefined) {
    return Effect.fail(
      new PolicyViolation({
        message: "Expected an explicit nextVersion when promoting a pack artifact into active.",
      }),
    );
  }

  if (input.nextVersion === input.sourceVersion) {
    return Effect.fail(
      new PolicyViolation({
        message:
          "Expected active promotion to create a new version instead of reusing the source artifact version.",
      }),
    );
  }

  const newestVersion = newestVersionForPack(input.catalog, input.packId);
  if (newestVersion !== undefined && comparePackVersions(input.nextVersion, newestVersion) <= 0) {
    return Effect.fail(
      new PolicyViolation({
        message:
          "Expected the next active pack version to sort after all recorded historical versions for the same pack id.",
      }),
    );
  }

  return Effect.succeed(input.nextVersion);
}

function ensureNoUnexpectedNextVersion(nextVersion: string | undefined) {
  return nextVersion === undefined
    ? Effect.void
    : Effect.fail(
        new PolicyViolation({
          message:
            "Expected nextVersion to be omitted for lifecycle-only curator actions that do not create a new active artifact.",
        }),
      );
}

export function applyPackGovernanceDecision(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PackGovernanceRequestSchema)(input),
      catch: (cause) =>
        new PolicyViolation({
          message: readCauseMessage(
            cause,
            "Failed to decode pack governance input through shared contracts.",
          ),
        }),
    });

    const subjectArtifact = findArtifact(
      decoded.catalog,
      decoded.subjectPackId,
      decoded.subjectPackVersion,
    );

    if (subjectArtifact === undefined) {
      return yield* Effect.fail(
        new PolicyViolation({
          message: "Expected the selected pack artifact to exist in the governance catalog.",
        }),
      );
    }

    yield* ensureDecisionMatchesSubject({
      subjectArtifact,
      subjectPackId: decoded.subjectPackId,
      subjectPackVersion: decoded.subjectPackVersion,
      decision: decoded.decision,
    });

    if (decoded.decision.toState === "active") {
      const nextVersion = yield* ensureNextVersion({
        catalog: decoded.catalog,
        packId: decoded.subjectPackId,
        sourceVersion: decoded.subjectPackVersion,
        nextVersion: decoded.nextVersion,
      });

      const existingActiveArtifact = findActiveArtifact(decoded.catalog, decoded.subjectPackId);
      const demotedActiveVersion = existingActiveArtifact?.definition.pack.version;
      const demotedActiveArtifact =
        existingActiveArtifact === undefined
          ? undefined
          : yield* transitionPackLifecycle({
              pack: existingActiveArtifact.definition.pack,
              to: "shadow",
              changedBy: decoded.changedBy,
              rationale: decoded.rationale,
              occurredAt: decoded.occurredAt,
            }).pipe(
              Effect.map((transitioned) =>
                buildTransitionedArtifact(
                  existingActiveArtifact,
                  {
                    ...existingActiveArtifact.definition,
                    pack: transitioned.pack,
                  },
                  decoded.occurredAt,
                  decoded.changedBy,
                ),
              ),
            );

      const activatedArtifact = buildActivatedArtifact({
        artifact: subjectArtifact,
        nextVersion,
        changedBy: decoded.changedBy,
        occurredAt: decoded.occurredAt,
        sourceDecisionId: decoded.decision.id,
        replacedActiveVersion: existingActiveArtifact?.definition.pack.version,
      });

      const nextCatalog = Schema.decodeUnknownSync(VersionedSitePackCatalogSchema)(
        demotedActiveArtifact === undefined
          ? [...decoded.catalog, activatedArtifact]
          : [...replaceArtifact(decoded.catalog, demotedActiveArtifact), activatedArtifact],
      );

      const auditTrail = Schema.decodeUnknownSync(AuditTrailSchema)([
        ...(demotedActiveArtifact === undefined
          ? []
          : [
              buildAuditRecord({
                decision: decoded.decision,
                auditKind: "demote-previous-active",
                packId: demotedActiveArtifact.definition.pack.id,
                sourceVersion:
                  demotedActiveVersion ?? demotedActiveArtifact.definition.pack.version,
                sourceState: "active",
                targetVersion: demotedActiveArtifact.definition.pack.version,
                targetState: demotedActiveArtifact.definition.pack.state,
                changedBy: decoded.changedBy,
                rationale: decoded.rationale,
                occurredAt: decoded.occurredAt,
              }),
            ]),
        buildAuditRecord({
          decision: decoded.decision,
          auditKind: "activate-version",
          packId: activatedArtifact.definition.pack.id,
          sourceVersion: subjectArtifact.definition.pack.version,
          sourceState: subjectArtifact.definition.pack.state,
          targetVersion: activatedArtifact.definition.pack.version,
          targetState: activatedArtifact.definition.pack.state,
          changedBy: decoded.changedBy,
          rationale: decoded.rationale,
          occurredAt: decoded.occurredAt,
        }),
      ]);

      return Schema.decodeUnknownSync(PackGovernanceResultSchema)({
        catalog: nextCatalog,
        activeArtifact: activatedArtifact,
        auditTrail,
      });
    }

    yield* ensureNoUnexpectedNextVersion(decoded.nextVersion);

    const transitioned = yield* transitionPackLifecycle({
      pack: subjectArtifact.definition.pack,
      to: decoded.decision.toState,
      changedBy: decoded.changedBy,
      rationale: decoded.rationale,
      occurredAt: decoded.occurredAt,
    });

    const transitionedArtifact = buildTransitionedArtifact(
      subjectArtifact,
      {
        ...subjectArtifact.definition,
        pack: transitioned.pack,
      },
      decoded.occurredAt,
      decoded.changedBy,
    );

    return Schema.decodeUnknownSync(PackGovernanceResultSchema)({
      catalog: Schema.decodeUnknownSync(VersionedSitePackCatalogSchema)(
        replaceArtifact(decoded.catalog, transitionedArtifact),
      ),
      auditTrail: [
        buildAuditRecord({
          decision: decoded.decision,
          auditKind: "transition",
          packId: transitionedArtifact.definition.pack.id,
          sourceVersion: subjectArtifact.definition.pack.version,
          sourceState: subjectArtifact.definition.pack.state,
          targetVersion: transitionedArtifact.definition.pack.version,
          targetState: transitionedArtifact.definition.pack.state,
          changedBy: decoded.changedBy,
          rationale: decoded.rationale,
          occurredAt: decoded.occurredAt,
        }),
      ],
    });
  });
}

export type PackGovernanceAuditKind = Schema.Schema.Type<typeof PackGovernanceAuditKindSchema>;
export type VersionedSitePackArtifactEncoded = Schema.Codec.Encoded<
  typeof VersionedSitePackArtifactSchema
>;
export type PackGovernanceAuditRecordEncoded = Schema.Codec.Encoded<
  typeof PackGovernanceAuditRecordSchema
>;
export type PackGovernanceResultEncoded = Schema.Codec.Encoded<typeof PackGovernanceResultSchema>;
