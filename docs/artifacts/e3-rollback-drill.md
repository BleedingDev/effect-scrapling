# E3 Rollback Drill Evidence

- Executed in an isolated disposable clone:
  `/var/folders/l5/j97t559s5ljgmjc_ylqn1jmh0000gn/T/e3-rollback-drill.XXXXXX.UtM20nNoOy/repo`
- Drill source commit:
  `56186dd94f6d1c95718b2943d47c2d909612d7fe`
- Overlay source: `/Users/satan/side/experiments/effect-scrapling`
- Note: macOS `mktemp -t` retains the `.XXXXXX` template marker in the concrete
  generated basename; the path above is the actual clone location used for this
  drill.

## Pre-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e3-capability-slice
bun run example:e3-capability-slice > tmp/e3-capability-slice.json
bun run scripts/benchmarks/e3-access-runtime.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e3-access-runtime-scorecard.json
```

Key evidence:

- `bun install --frozen-lockfile`: `457 packages installed [947.00ms]`
- `bun run check:e3-capability-slice`: completed successfully before rollback
- benchmark status before rollback: `pass`
- baseline p95 before rollback: `0.928ms`
- candidate p95 before rollback: `3.957ms`
- retry-recovery p95 before rollback: `255.96ms`

Capability example output (head):

```json
{
  "target": {
    "id": "target-product-001",
    "tenantId": "tenant-main",
    "domain": "example.com",
    "kind": "productPage",
    "canonicalKey": "catalog/product-001"
  },
  "pack": {
    "id": "pack-example-com",
    "domainPattern": "*.example.com",
    "state": "shadow",
    "accessPolicyId": "policy-http",
    "version": "2026.03.06"
  },
  "accessPolicy": {
    "id": "policy-http",
    "mode": "http",
    "perDomainConcurrency": 2,
    "globalConcurrency": 4,
    "timeoutMs": 5000,
    "maxRetries": 1,
    "render": "never"
  }
}
```

## Rollback Step

Command:

```bash
rm -rf node_modules dist tmp/e3-capability-slice.json tmp/e3-access-runtime-scorecard.json
```

Post-step filesystem state:

- `node_modules`: absent
- `dist`: absent
- `tmp/e3-capability-slice.json`: absent
- `tmp/e3-access-runtime-scorecard.json`: absent

## Post-recovery

Commands:

```bash
bun install --frozen-lockfile
bun run check:e3-capability-slice
bun run example:e3-capability-slice > tmp/e3-capability-slice.json
bun run scripts/benchmarks/e3-access-runtime.ts \
  --sample-size 3 \
  --warmup 1 \
  --artifact tmp/e3-access-runtime-scorecard.json
```

Key evidence:

- `bun install --frozen-lockfile`: `457 packages installed [634.00ms]`
- `bun run check:e3-capability-slice`: completed successfully after rollback
- `bun run example:e3-capability-slice`: completed successfully after rollback
- benchmark status after rollback: `pass`
- baseline p95 after rollback: `1.065ms`
- candidate p95 after rollback: `3.674ms`
- retry-recovery p95 after rollback: `255.35ms`

Capability example output after recovery (head):

```json
{
  "target": {
    "id": "target-product-001",
    "tenantId": "tenant-main",
    "domain": "example.com",
    "kind": "productPage",
    "canonicalKey": "catalog/product-001"
  },
  "pack": {
    "id": "pack-example-com",
    "domainPattern": "*.example.com",
    "state": "shadow",
    "accessPolicyId": "policy-http",
    "version": "2026.03.06"
  }
}
```

Reduced benchmark artifact after recovery:

```json
{
  "benchmark": "e3-access-runtime",
  "generatedAt": "2026-03-07T06:28:13.192Z",
  "environment": {
    "bun": "1.3.10",
    "platform": "darwin",
    "arch": "arm64"
  },
  "sampleSize": 3,
  "warmupIterations": 1,
  "budgets": {
    "baselineAccessP95Ms": 25,
    "candidateAccessP95Ms": 50,
    "retryRecoveryP95Ms": 300
  },
  "measurements": {
    "baselineAccess": {
      "samples": 3,
      "minMs": 0.933,
      "meanMs": 1.011,
      "p95Ms": 1.065,
      "maxMs": 1.065
    },
    "candidateAccess": {
      "samples": 3,
      "minMs": 2.64,
      "meanMs": 3.013,
      "p95Ms": 3.674,
      "maxMs": 3.674
    },
    "retryRecovery": {
      "samples": 3,
      "minMs": 253.634,
      "meanMs": 254.497,
      "p95Ms": 255.35,
      "maxMs": 255.35
    }
  },
  "comparison": {
    "baselinePath": null,
    "deltas": {
      "baselineAccessP95Ms": null,
      "candidateAccessP95Ms": null,
      "retryRecoveryP95Ms": null
    }
  },
  "status": "pass"
}
```

## Outcome

The E3 rollback and recovery drill passed end to end:

- frozen install succeeded before and after rollback
- the integrated E3 capability slice stayed green before and after recovery
- the public capability example kept the HTTP-first runtime contract intact
- the reduced benchmark stayed `pass` before and after rollback
- baseline, candidate, and retry-recovery measurements remained bounded after
  recovery
- repository-generated state was removed and rebuilt cleanly
