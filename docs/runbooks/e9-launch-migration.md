# E9 Launch Migration

Use this migration guide when moving from the E8 public control-plane proof to
the E9 launch-ready retailer hardening slice.

## Migration path

1. Replay security-focused E9 gates:

```bash
bun run check:e9-security-review
bun run check:e9-artifact-segregation
```

2. Replay retailer evidence:

```bash
bun run check:e9-reference-packs
bun run check:e9-scrapling-parity
bun run check:e9-high-friction-canary
```

3. Replay launch readiness:

```bash
bun run check:e9-launch-readiness
```

## Promotion path

1. Keep packs in `shadow` until `check:e9-reference-packs` is green.
2. Promote only through the governed path already validated by the E9 reference
   pack artifact.
3. Keep the resulting active versions immutable; publish a fresh version for the
   next promotion.

## Incident rollback path

1. Revert to the previous active reference-pack version.
2. Replay the canary and parity lanes before re-promoting.
3. Do not weaken redaction or bypass policy to “restore service”.
