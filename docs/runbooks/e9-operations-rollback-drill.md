# E9 Operations Rollback Drill

Use this drill to rehearse incident rollback for E9 retailer launch evidence.

## Drill commands

```bash
bun run check:e9-reference-packs
bun run check:e9-scrapling-parity
bun run check:e9-high-friction-canary
bun run check:e9-launch-readiness
```

## Rollback procedure

1. Treat the current active reference-pack artifact as suspect.
2. Re-activate the previous active version through the governed pack lane.
3. Re-run:
   - `bun run check:e9-reference-packs`
   - `bun run check:e9-high-friction-canary`
4. If parity evidence also drifted, rerun:
   - `bun run check:e9-scrapling-parity`
5. Only restore launch readiness when `bun run check:e9-launch-readiness` is
   green again.

## Do not do this

- do not bypass the governed promotion path
- do not relabel a failed canary as acceptable
- do not weaken E9 security review checks to recover a launch lane
