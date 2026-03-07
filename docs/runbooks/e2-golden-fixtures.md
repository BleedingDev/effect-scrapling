# E2 Golden Fixtures

## Purpose

Golden fixtures replay a committed extraction run from stored HTTP capture
payloads instead of live network access. In the current repository, they are
used to keep parser, selector, normalizer, assertion, snapshot, and evidence
assembly behavior stable across reruns.

This runbook is for two audiences:

- operators who need to reproduce or triage fixture regressions locally
- SDK consumers inside this repository who need to call the replay APIs directly

## Current Contract

The committed surface area today is:

- Fixture bank schema and replay APIs:
  `libs/foundation/core/src/golden-fixtures.ts`
- Focused deterministic replay test:
  `tests/libs/foundation-core-golden-fixtures.test.ts`
- Committed fixture bank:
  `tests/fixtures/foundation-core-e2-golden-fixtures.json`
- End-to-end comparison example:
  `examples/e2-capability-slice.ts`

The current fixture bank contains two cases:

- `golden-product-relocated`
  - expected result: `success`
  - covers selector fallback relocation for `price`
  - normalizes `title`, `price`, and `availability`
- `golden-product-assertion-failure`
  - expected result: `failure`
  - current error code: `extraction_mismatch`
  - current error message:
    `Extraction assertions failed: Field availability violates extractor assertions.`

Behavioral constraints enforced today:

- the bank must be non-empty
- `fixtureId` values must be unique across the bank
- `replayGoldenFixture(...)` returns a tagged union:
  - `kind: "success"` with replayed extraction output
  - `kind: "failure"` with a core error envelope
- malformed fixture input is decoded against `GoldenFixtureCaseSchema` before
  replay starts
- the focused test replays fixtures sequentially with `concurrency: 1` and
  compares encoded replay output to encoded `expected` output exactly

## Operator Workflow

### Run the focused deterministic replay suite

```bash
bun test tests/libs/foundation-core-golden-fixtures.test.ts
```

Expected result today:

```text
1 pass
0 fail
```

Use this command when you need to answer a single question: "Does the current
extractor still reproduce the committed golden outputs exactly?"

### Inspect the committed fixture bank quickly

List fixture ids and expected result kinds:

```bash
jq '[.[] | {fixtureId, expectedKind: .expected.kind}]' \
  tests/fixtures/foundation-core-e2-golden-fixtures.json
```

Inspect the current failure fixture envelope:

```bash
jq '.[1] | {fixtureId, errorCode: .expected.error.code, errorMessage: .expected.error.message}' \
  tests/fixtures/foundation-core-e2-golden-fixtures.json
```

### Run the capability slice against the golden baseline

```bash
bun run examples/e2-capability-slice.ts
```

This example:

- loads the committed bank
- replays `golden-product-relocated` as the baseline
- captures a candidate HTML response with a changed `price`
- runs extractor orchestration on the candidate
- computes a snapshot diff against the baseline replay

For a smaller view of the example output:

```bash
bun run examples/e2-capability-slice.ts | jq '{
  fixtureId,
  baselineDocumentArtifactId: .baselineReplay.documentArtifactId,
  diffChangedFields: [.snapshotDiff.changes[].field],
  candidatePrice: .candidateOrchestration.snapshotAssembly.snapshot.observations[]
    | select(.field == "price")
    | .normalizedValue.amount
}'
```

Current expected signal from that example:

- `fixtureId` is `golden-product-relocated`
- `diffChangedFields` contains `price`
- `candidatePrice` is `21.49`

## SDK Consumer Workflow

### Replay one committed fixture end-to-end

From a repository-root script:

```ts
import { Effect, Match, Schema } from "effect";
import {
  GoldenFixtureBankSchema,
  GoldenFixtureReplayResultSchema,
  replayGoldenFixture,
} from "./libs/foundation/core/src/golden-fixtures.ts";

const fixtureJson = await Bun.file(
  "tests/fixtures/foundation-core-e2-golden-fixtures.json",
).json();
const fixtureBank = Schema.decodeUnknownSync(GoldenFixtureBankSchema)(fixtureJson);

const replay = await Effect.runPromise(replayGoldenFixture(fixtureBank[0]));

const encoded = Schema.encodeSync(GoldenFixtureReplayResultSchema)(replay);
console.log(JSON.stringify(encoded, null, 2));

await Effect.runPromise(
  Match.value(replay).pipe(
    Match.when({ kind: "success" }, () => Effect.void),
    Match.when({ kind: "failure" }, ({ error }) =>
      Effect.fail(new Error(`${error.code}: ${error.message}`)),
    ),
    Match.exhaustive,
  ),
);
```

Use `replayGoldenFixture(...)` when you want the full committed replay contract,
including expected failure cases.

### Reuse the committed payload loader directly

Use `makeGoldenReplayLoader(...)` when you already have a decoded fixture and
want to call `runExtractorOrchestration(...)` yourself:

```ts
import { Effect, Schema } from "effect";
import {
  GoldenFixtureBankSchema,
  makeGoldenReplayLoader,
} from "./libs/foundation/core/src/golden-fixtures.ts";
import { runExtractorOrchestration } from "./libs/foundation/core/src/extractor-runtime.ts";

const fixtureJson = await Bun.file(
  "tests/fixtures/foundation-core-e2-golden-fixtures.json",
).json();
const fixtureBank = Schema.decodeUnknownSync(GoldenFixtureBankSchema)(fixtureJson);
const fixture = fixtureBank[0];

const result = await Effect.runPromise(
  runExtractorOrchestration(
    {
      plan: fixture.plan,
      artifacts: fixture.captureBundle.artifacts,
      recipe: fixture.recipe,
      createdAt: fixture.plan.createdAt,
    },
    makeGoldenReplayLoader(fixture),
  ),
);

console.log(result.snapshotAssembly.snapshot.id);
```

This path is useful when you need orchestration output only and do not need the
`success` or `failure` replay wrapper.

## Rollout Guidance

Current rollout is source-controlled. There is no separate runtime toggle,
feature flag, or fixture registry service in this repository today.

When intentionally changing golden behavior:

1. Update `tests/fixtures/foundation-core-e2-golden-fixtures.json` to reflect
   the new committed baseline.
2. Keep existing `fixtureId` values stable unless you are intentionally
   replacing the scenario. The capability slice currently depends on
   `golden-product-relocated`.
3. Re-run the focused replay suite:

   ```bash
   bun test tests/libs/foundation-core-golden-fixtures.test.ts
   ```

4. Re-run the capability slice:

   ```bash
   bun run examples/e2-capability-slice.ts
   ```

5. Review whether the changed output is intentional:
   - changed replay output in the focused test means the baseline moved
   - changed `snapshotDiff` in the capability slice means the candidate example
     now compares against a different baseline

Do not update the committed fixture bank just to silence a failing replay.
Treat every baseline change as an explicit extraction behavior change.

## Rollback Guidance

Rollback is also source-controlled.

If a fixture refresh or consumer change turns out to be wrong:

1. Revert `tests/fixtures/foundation-core-e2-golden-fixtures.json` to the last
   known-good version.
2. Revert any code that started depending on the new fixture ids or new replay
   outputs.
3. Re-run:

   ```bash
   bun test tests/libs/foundation-core-golden-fixtures.test.ts
   bun run examples/e2-capability-slice.ts
   ```

4. Confirm that:
   - the focused replay suite is green again
   - the capability slice again shows the expected single `price` change against
     `golden-product-relocated`

If you need a fast rollback decision, prefer reverting the fixture bank change
instead of editing expected values by hand under pressure.

## Troubleshooting

### `Failed to load golden fixture bank`

The focused test and capability slice both read
`tests/fixtures/foundation-core-e2-golden-fixtures.json`.

Check:

- the file still exists at that path
- the JSON is valid
- the JSON still decodes as a non-empty `GoldenFixtureBankSchema`

### Duplicate or missing fixtures are rejected

`GoldenFixtureBankSchema` rejects:

- an empty fixture bank
- duplicate `fixtureId` values

If you are adding a new case, validate ids first:

```bash
jq 'map(.fixtureId)' tests/fixtures/foundation-core-e2-golden-fixtures.json
```

### `Failed to decode golden fixture case`

`replayGoldenFixture(...)` decodes input against `GoldenFixtureCaseSchema`
before replay. This means malformed fixture structure fails before extractor
orchestration runs.

Practical checks:

- `plan` still matches the committed run-plan shape
- `recipe` still matches the committed extraction-recipe shape
- `captureBundle` still contains the artifacts and payloads required by the case
- `expected` still uses the replay result union shape

### The focused replay test fails with an exact mismatch

This means the encoded replay output no longer matches the committed
`expected` value byte-for-byte at the schema level.

Start with:

1. `bun test tests/libs/foundation-core-golden-fixtures.test.ts`
2. `bun run examples/e2-capability-slice.ts | jq '.snapshotDiff'`
3. inspect whether the change is:
   - selector relocation behavior
   - normalized field output
   - assertion result
   - evidence manifest or snapshot assembly output

If the mismatch was not intentional, fix extractor behavior instead of updating
the fixture bank.

### `Expected golden fixture ... to replay successfully`

`examples/e2-capability-slice.ts` hardcodes `golden-product-relocated` as a
success baseline. You will hit this if that fixture is removed or changed into a
failure case.

Fix by restoring the success fixture or by updating the example intentionally in
the same change.

### `Extraction assertions failed: Field availability violates extractor assertions.`

This exact message is currently the committed expected failure for
`golden-product-assertion-failure`.

Interpret it carefully:

- expected when replaying that failure fixture
- unexpected when it appears in `golden-product-relocated` or another success
  path

If it appears on a success path, treat it as an extraction regression, not an
infrastructure problem.
