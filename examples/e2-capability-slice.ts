import { Effect, Match, Schema } from "effect";
import { SnapshotDiffSchema } from "../libs/foundation/core/src/diff-verdict.ts";
import {
  ExtractorOrchestrationResultSchema,
  makeHttpCapturePayloadLoader,
  runExtractorOrchestration,
} from "../libs/foundation/core/src/extractor-runtime.ts";
import {
  GoldenFixtureBankSchema,
  GoldenFixtureReplaySuccessSchema,
  replayGoldenFixture,
} from "../libs/foundation/core/src/golden-fixtures.ts";
import {
  HttpCaptureBundleSchema,
  captureHttpArtifacts,
} from "../libs/foundation/core/src/http-access-runtime.ts";
import { RunPlanSchema } from "../libs/foundation/core/src/run-state.ts";
import { CanonicalIdentifierSchema } from "../libs/foundation/core/src/schema-primitives.ts";
import { compareSnapshots } from "../libs/foundation/core/src/snapshot-diff-engine.ts";

const GOLDEN_FIXTURE_BANK_URL = new URL(
  "../tests/fixtures/foundation-core-e2-golden-fixtures.json",
  import.meta.url,
);
const FIXTURE_ID = "golden-product-relocated";
const CAPTURED_AT = "2026-03-06T13:00:06.000Z";
const ORCHESTRATED_AT = "2026-03-06T13:00:07.000Z";
const DIFFED_AT = "2026-03-06T13:00:08.000Z";

const CANDIDATE_HTML = `
  <html>
    <body>
      <article data-sku="sku-101">
        <h1 class="product-title"> Example Product </h1>
        <div class="pricing">
          <span data-testid="price"> $21.49 </span>
          <span class="price-fallback"> USD 21.49 </span>
        </div>
        <span class="availability"> In stock </span>
      </article>
    </body>
  </html>
`;

async function loadFixtureBankJson() {
  return Bun.file(GOLDEN_FIXTURE_BANK_URL).json();
}

export class E2CapabilitySliceEvidence extends Schema.Class<E2CapabilitySliceEvidence>(
  "E2CapabilitySliceEvidence",
)({
  fixtureId: CanonicalIdentifierSchema,
  baselineReplay: GoldenFixtureReplaySuccessSchema,
  candidateCaptureBundle: HttpCaptureBundleSchema,
  candidateOrchestration: ExtractorOrchestrationResultSchema,
  snapshotDiff: SnapshotDiffSchema,
}) {}

export const E2CapabilitySliceEvidenceSchema = E2CapabilitySliceEvidence;

export function runE2CapabilitySlice() {
  return Effect.gen(function* () {
    const fixtureBank = yield* Effect.tryPromise({
      try: async () =>
        Schema.decodeUnknownSync(GoldenFixtureBankSchema)(await loadFixtureBankJson()),
      catch: (cause) => new Error(`Failed to load E2 golden fixture bank: ${String(cause)}`),
    });
    const fixture = fixtureBank.find(({ fixtureId }) => fixtureId === FIXTURE_ID);

    if (fixture === undefined) {
      return yield* Effect.fail(
        new Error(`Could not find golden fixture ${FIXTURE_ID} for the E2 capability slice.`),
      );
    }

    const baselineReplay = yield* replayGoldenFixture(fixture);
    const baselineSuccess = yield* Match.value(baselineReplay).pipe(
      Match.when({ kind: "success" }, ({ result }) => Effect.succeed(result)),
      Match.when({ kind: "failure" }, ({ error }) =>
        Effect.fail(
          new Error(
            `Expected golden fixture ${FIXTURE_ID} to replay successfully, got ${error.code}: ${error.message}`,
          ),
        ),
      ),
      Match.exhaustive,
    );

    const baselinePlan = Schema.encodeSync(RunPlanSchema)(fixture.plan);
    const candidatePlan = Schema.decodeUnknownSync(RunPlanSchema)({
      ...baselinePlan,
      id: `${baselinePlan.id}-candidate`,
      createdAt: CAPTURED_AT,
    });
    const candidateCaptureBundle = yield* captureHttpArtifacts(
      candidatePlan,
      () =>
        Promise.resolve(
          new Response(CANDIDATE_HTML, {
            status: 200,
            headers: {
              "content-type": "text/html; charset=utf-8",
            },
          }),
        ),
      () => new Date(CAPTURED_AT),
      () => 8.25,
    );
    const candidateOrchestration = yield* runExtractorOrchestration(
      {
        plan: candidatePlan,
        artifacts: candidateCaptureBundle.artifacts,
        recipe: fixture.recipe,
        createdAt: ORCHESTRATED_AT,
      },
      makeHttpCapturePayloadLoader(candidateCaptureBundle),
    );
    const snapshotDiff = yield* compareSnapshots({
      id: "e2-capability-slice-diff",
      baseline: baselineSuccess.snapshotAssembly.snapshot,
      candidate: candidateOrchestration.snapshotAssembly.snapshot,
      createdAt: DIFFED_AT,
      latencyDeltaMs: -4,
      memoryDelta: -128,
    });

    return Schema.decodeUnknownSync(E2CapabilitySliceEvidenceSchema)({
      fixtureId: fixture.fixtureId,
      baselineReplay: baselineSuccess,
      candidateCaptureBundle,
      candidateOrchestration,
      snapshotDiff,
    });
  });
}

export function runE2CapabilitySliceEncoded() {
  return runE2CapabilitySlice().pipe(
    Effect.map((evidence) => Schema.encodeSync(E2CapabilitySliceEvidenceSchema)(evidence)),
  );
}

if (import.meta.main) {
  const encoded = await Effect.runPromise(runE2CapabilitySliceEncoded());
  process.stdout.write(`${JSON.stringify(encoded, null, 2)}\n`);
}
