# Lockstep Workspace Version Policy Runbook

## Purpose

`bun run check:lockstep-version` enforces a lockstep release train for workspace package versions:

- Root `package.json` `version` is the source of truth.
- Every discovered `package.json` with a `version` field must match the root version exactly.
- Any mismatch is a blocking failure.

This runbook defines how to run the check, interpret output, remediate failures, and roll out or roll back version changes without bypassing policy.

## How to run

Run from repository root:

```bash
bun run check:lockstep-version
```

Run full required gates before merge:

```bash
bun run check
```

Helpful inventory command:

```bash
rg -n '"version"\\s*:' --glob '**/package.json'
```

## Expected output and practical examples

### Pass output

When all `version` fields are aligned:

```text
Workspace version lockstep policy OK: <N> package.json files scanned, all version fields match "<root-version>".
```

Example:

```text
Workspace version lockstep policy OK: 14 package.json files scanned, all version fields match "0.2.0".
```

### Fail output: package drift

When one or more workspace packages drift:

```text
Workspace version lockstep policy failed: expected "<root-version>" in all package.json files with a version field.
- apps/api/package.json: found "0.3.0"
```

Practical example:

- Root `package.json` has `"version": "0.2.0"`.
- `apps/api/package.json` has `"version": "0.3.0"`.
- Check exits with status `1` and prints the failure lines above.

### Fail output: root version is invalid

If root version is missing or not a non-empty string:

```text
Missing or invalid string version in root package.json
```

### Fail output: unreadable or invalid JSON

If any scanned `package.json` cannot be read or parsed:

```text
Failed to read apps/api/package.json: <parse-or-io-error>
```

## Troubleshooting and remediation

1. Run `bun run check:lockstep-version` and identify each reported path under failure output.
2. Open each listed `package.json` and set `version` to the exact root `package.json` version string.
3. If root `package.json` has no valid version, set a valid SemVer string (for example `"0.2.0"`).
4. If the check reports parse/read errors, fix malformed JSON or restore missing files.
5. Re-run the guardrail until it passes.
6. Run `bun run check` to verify all required gates still pass.

Remediation command pattern:

```bash
rg -n '"version"\\s*:' --glob '**/package.json'
```

Use this to quickly verify all committed `version` values are aligned before re-running the guardrail.

## Rollout guidance

1. Plan a single lockstep version target (for example `0.3.0`).
2. Update root `package.json` version and all workspace `package.json` files that declare `version` in the same change set.
3. Run `bun run check:lockstep-version`.
4. Run full gates (`bun run check`) before merge.
5. Merge only when lockstep check and full gates are green in both local and CI.

## Rollback guidance

If a rollout introduces lockstep failures:

1. Revert the version bump commit (or revert only the mismatched package edits) to the last known-good lockstep state.
2. Re-run `bun run check:lockstep-version`.
3. Re-run `bun run check`.
4. Re-attempt rollout with a corrected lockstep edit set.

Rollback is performed by code reversion, not by policy relaxation.

## Strict no-bypass posture

The lockstep guardrail is mandatory and must not be bypassed.

Forbidden actions:

- Removing `check:lockstep-version` from `package.json` scripts.
- Removing lockstep enforcement from `bun run check`.
- Weakening CI/workflow steps to skip the check.
- Editing guardrail code to ignore mismatches or allow exceptions.
- Using ad-hoc local-only workflows to ship with known drift.

Any failure is release-blocking until fixed in source control and revalidated.
