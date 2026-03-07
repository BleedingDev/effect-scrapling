# E4 Rollback Drill Evidence

- Executed in an isolated disposable clone:
  `/var/folders/l5/j97t559s5ljgmjc_ylqn1jmh0000gn/T/e4-rollback-drill.XXXXXX.qwgT8N4dwL/repo`
- Drill source commit:
  `f1312ac7eca538ad269f36b875b41d6095daaf60`
- Browser-runtime note:
  `browser:install` completed in the disposable clone and `check:playwright`
  reported Playwright `1.58.2` before and after the rollback step. The drill
  removed repository-generated state only; the shared Playwright browser cache
  remained outside the repo, which matches the current E4 runbook contract.

## Steps And Evidence

### 1. Setup And Browser Bootstrap Before Rollback

Commands:

```bash
bun install --frozen-lockfile
bun run browser:install
bun run check:playwright
```

Key evidence:

```text
457 packages installed [827.00ms]
Version 1.58.2
```

### 2. Initial Integrated E4 Readiness Before Rollback

Commands:

```bash
bun run check:e4-capability-slice
bun run example:e4-capability-slice > tmp/e4-capability-slice.json
bun run benchmark:e4-browser-soak-load -- --rounds 2 --concurrency 2 --warmup 0 --artifact tmp/e4-browser-soak-load.json
```

Capability-slice evidence:

```json
{
  "requiresBrowser": true,
  "rationaleKeys": [
    "mode",
    "rendering",
    "budget",
    "capture-path"
  ],
  "captureKinds": [
    "renderedDom",
    "screenshot",
    "networkSummary",
    "timings"
  ],
  "policyOutcomes": [
    "sessionIsolation:allowed",
    "sessionIsolation:allowed",
    "originRestriction:allowed",
    "sessionIsolation:allowed",
    "sessionIsolation:allowed",
    "originRestriction:allowed"
  ],
  "leakSnapshot": {
    "openBrowsers": 0,
    "openContexts": 0,
    "openPages": 0,
    "consecutiveViolationCount": 0,
    "sampleCount": 12,
    "lastPlanId": "plan-target-browser-search-001-pack-example-com",
    "recordedAt": "2026-03-07T10:01:00.036Z"
  },
  "crashTelemetryCount": 0,
  "lifecycle": {
    "launches": 2,
    "browserCloses": 2,
    "contextCloses": 2,
    "pageCloses": 2
  }
}
```

Soak/load artifact summary before rollback:

```json
{
  "status": "pass",
  "captures": {
    "totalRuns": 4,
    "totalArtifacts": 16,
    "artifactKinds": [
      "renderedDom",
      "screenshot",
      "networkSummary",
      "timings"
    ]
  },
  "peaks": {
    "openBrowsers": 1,
    "openContexts": 2,
    "openPages": 2
  },
  "finalSnapshot": {
    "openBrowsers": 0,
    "openContexts": 0,
    "openPages": 0,
    "consecutiveViolationCount": 0,
    "sampleCount": 20,
    "lastPlanId": "plan-browser-soak-1-0",
    "recordedAt": "2026-03-07T00:00:00.068Z"
  },
  "alarms": [],
  "crashTelemetry": [],
  "violations": []
}
```

### 3. Rollback Step

Command:

```bash
rm -rf node_modules dist tmp/e4-browser-soak-load.json
```

Post-step filesystem state:

- `node_modules`: absent
- `dist`: absent
- `tmp/e4-browser-soak-load.json`: absent

### 4. Recovery After Rollback

Commands:

```bash
bun install --frozen-lockfile
bun run check:playwright
bun run check:e4-capability-slice
bun run benchmark:e4-browser-soak-load -- --rounds 2 --concurrency 2 --warmup 0 --artifact tmp/e4-browser-soak-load.json
```

Key evidence:

```text
457 packages installed [603.00ms]
Version 1.58.2
```

Soak/load artifact summary after recovery:

```json
{
  "status": "pass",
  "captures": {
    "totalRuns": 4,
    "totalArtifacts": 16,
    "artifactKinds": [
      "renderedDom",
      "screenshot",
      "networkSummary",
      "timings"
    ]
  },
  "peaks": {
    "openBrowsers": 1,
    "openContexts": 2,
    "openPages": 2
  },
  "finalSnapshot": {
    "openBrowsers": 0,
    "openContexts": 0,
    "openPages": 0,
    "consecutiveViolationCount": 0,
    "sampleCount": 20,
    "lastPlanId": "plan-browser-soak-1-0",
    "recordedAt": "2026-03-07T00:00:00.068Z"
  },
  "alarms": [],
  "crashTelemetry": [],
  "violations": []
}
```

## Outcome

The E4 rollback and recovery drill passed end to end:

- frozen install succeeded before and after rollback
- the browser runtime remained ready after recovery
- the integrated capability slice stayed browser-backed with deterministic
  rationale and artifact ordering
- security decisions stayed explicit and all observed policy outcomes were
  `allowed` on the healthy path
- the reduced soak/load artifact stayed `pass` before and after rollback
- no leak alarms, crash telemetry, or dangling browser resources were observed
