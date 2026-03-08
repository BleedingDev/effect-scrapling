import { Effect, Schema } from "effect";
import { CanonicalIdentifierSchema, IsoDateTimeSchema } from "./schema-primitives.ts";
import { PackLifecycleTransitionSchema, PackStateSchema, SitePackSchema } from "./site-pack.ts";
import { PolicyViolation } from "./tagged-errors.ts";

const NonEmptyMessageSchema = Schema.Trim.check(Schema.isNonEmpty());

export class PackLifecycleTransitionRequest extends Schema.Class<PackLifecycleTransitionRequest>(
  "PackLifecycleTransitionRequest",
)({
  pack: SitePackSchema,
  to: PackStateSchema,
  changedBy: CanonicalIdentifierSchema,
  rationale: NonEmptyMessageSchema,
  occurredAt: IsoDateTimeSchema,
}) {}

export class PackLifecycleTransitionEvent extends Schema.Class<PackLifecycleTransitionEvent>(
  "PackLifecycleTransitionEvent",
)({
  id: CanonicalIdentifierSchema,
  packId: CanonicalIdentifierSchema,
  packVersion: CanonicalIdentifierSchema,
  from: PackStateSchema,
  to: PackStateSchema,
  changedBy: CanonicalIdentifierSchema,
  rationale: NonEmptyMessageSchema,
  occurredAt: IsoDateTimeSchema,
}) {}

export class PackLifecycleTransitionResult extends Schema.Class<PackLifecycleTransitionResult>(
  "PackLifecycleTransitionResult",
)({
  pack: SitePackSchema,
  event: PackLifecycleTransitionEvent,
}) {}

export const PackLifecycleTransitionRequestSchema = PackLifecycleTransitionRequest;
export const PackLifecycleTransitionEventSchema = PackLifecycleTransitionEvent;
export const PackLifecycleTransitionResultSchema = PackLifecycleTransitionResult;

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function transitionEventId(input: Schema.Schema.Type<typeof PackLifecycleTransitionRequestSchema>) {
  return `pack-transition-${input.pack.id}-${input.pack.version}-${input.to}-${input.occurredAt}`;
}

export function transitionPackLifecycle(input: unknown) {
  return Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PackLifecycleTransitionRequestSchema)(input),
      catch: (cause) =>
        new PolicyViolation({
          message: readCauseMessage(
            cause,
            "Failed to decode pack lifecycle transition input through shared contracts.",
          ),
        }),
    });

    yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(PackLifecycleTransitionSchema)({
          from: decoded.pack.state,
          to: decoded.to,
        }),
      catch: () =>
        new PolicyViolation({
          message: `Expected a valid pack lifecycle transition from ${decoded.pack.state} to ${decoded.to}.`,
        }),
    });

    return Schema.decodeUnknownSync(PackLifecycleTransitionResultSchema)({
      pack: {
        ...decoded.pack,
        state: decoded.to,
      },
      event: {
        id: transitionEventId(decoded),
        packId: decoded.pack.id,
        packVersion: decoded.pack.version,
        from: decoded.pack.state,
        to: decoded.to,
        changedBy: decoded.changedBy,
        rationale: decoded.rationale,
        occurredAt: decoded.occurredAt,
      },
    });
  });
}

export type PackLifecycleTransitionEventEncoded = Schema.Codec.Encoded<
  typeof PackLifecycleTransitionEventSchema
>;
export type PackLifecycleTransitionResultEncoded = Schema.Codec.Encoded<
  typeof PackLifecycleTransitionResultSchema
>;
