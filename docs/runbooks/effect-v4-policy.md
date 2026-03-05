# Effect v4 Dependency Policy Runbook

## Scope

This runbook is for operators and maintainers enforcing the repository Effect dependency guardrail in a Bun + TypeScript workspace.

Policy baseline:
- Effect is **v4 only**.
- **No Effect v3 dependencies** are allowed.
- Legacy split packages are denied: `@effect-ts/core`, `@effect-ts/system`, `@effect/data`, `@effect/io`, `@effect/match`, `@effect/schema`, `@effect/stream`.
- `bun.lock` is required and must resolve `effect` to v4.

## Command Usage

Run from repository root:

```bash
bun run check:effect-v4-policy
```

For full guardrail gates:

```bash
bun run check
```

Targeted dependency inspection helpers:

```bash
rg -n '"effect"\\s*:' **/package.json
rg -n '@effect-ts/core|@effect-ts/system|@effect/data|@effect/io|@effect/match|@effect/schema|@effect/stream' **/package.json bun.lock
```

## Expected Output

Pass example:

```text
Effect v4 dependency policy check passed (N package.json file(s) + bun.lock).
```

Fail examples:

```text
Effect v4 dependency policy violations detected:
- package.json#dependencies: effect must use a v4-only semver range (found "^3.16.0").
```

```text
Effect v4 dependency policy violations detected:
- bun.lock#packages: resolved effect version must be v4 (found "3.16.0").
```

```text
Effect v4 dependency policy violations detected:
- bun.lock: disallowed Effect dependency "@effect/data" detected.
```

```text
Effect v4 dependency policy violations detected:
- bun.lock: bun.lock is required for deterministic dependency checks.
```

## Accepted and Rejected Dependency Forms

Accepted `effect` specifiers:
- `^4.1.0`
- `~4.2.0`
- `4.3.1`
- `>=4 <5`

Rejected `effect` specifiers:
- `^3.16.0`
- `latest`
- `*`
- `workspace:^4.1.0`
- `file:../effect`
- `link:../effect`
- `git+https://...`
- `github:Effect-TS/effect`
- `http://...` / `https://...`

Rejected alias example:
- `@app/effect-alias: npm:effect@^3.16.0`

## Troubleshooting Checklist

1. Confirm `bun.lock` exists at repo root and is readable.
2. Scan every `package.json` dependency section: `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`.
3. Ensure every `effect` specifier is v4-only (`^4...`, `~4...`, exact `4...`, or `>=4 <5`).
4. Check aliases using `npm:effect@...`; they must resolve to v4 only.
5. Remove all denylisted legacy Effect packages from manifests.
6. Regenerate lockfile after dependency edits (`bun install`) and verify resolved `effect` is v4.
7. Re-run `bun run check:effect-v4-policy`.
8. Before closure, run full gates (`bun run check`) so policy remains aligned with lint/test/build.

## Rollout Guidance

1. Prepare
- Create a branch for dependency updates.
- Confirm current baseline passes: `bun run check:effect-v4-policy`.

2. Apply
- Update manifest ranges to v4-only forms.
- Remove all denylisted v3-era packages.
- Run `bun install` to refresh `bun.lock`.

3. Verify
- Run `bun run check:effect-v4-policy`.
- Run `bun run check` before merge.

4. Promote
- Merge only when guardrail output is clean.
- Monitor CI for post-merge guardrail regressions.

## Rollback Guidance

Use rollback when a dependency change introduces guardrail failures late in the rollout.

1. Identify the last green commit where `bun run check:effect-v4-policy` passed.
2. Revert only the offending dependency/lockfile changes (do not disable or bypass guardrails).
3. Run `bun install` if needed to restore lockfile consistency.
4. Re-run `bun run check:effect-v4-policy` and then `bun run check`.
5. Re-attempt rollout with corrected v4-only dependency specs.

## Operator Notes

- Do not weaken policy enforcement to pass CI.
- Do not introduce temporary exceptions for Effect v3 or denylisted legacy packages.
- Treat guardrail failures as blocking release issues until corrected.
