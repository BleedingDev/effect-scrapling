# E0 Rollback Drill Evidence

- Executed in an isolated disposable clone:
  `/private/tmp/e0-rollback-drill.njBxVs/repo`
- Drill source commit:
  `83dd7d2636abaf02f5496f2e3609556716d1f7e4`

## Steps And Evidence

### 1. Preflight before rollback

Command:

```bash
bun run scripts/preflight-bootstrap.ts
```

Result:

```text
Preflight passed (5/5 checks).
```

### 2. Initial readiness before rollback

Commands:

```bash
bun install --frozen-lockfile
bun run scripts/bootstrap-doctor.ts
```

Key evidence:

```text
456 packages installed [387.00ms]
Bootstrap doctor passed (12 readiness gates).
```

### 3. Rollback step

Command:

```bash
rm -rf node_modules dist
```

Post-step filesystem state:

- `node_modules`: absent
- `dist`: absent

### 4. Recovery after rollback

Commands:

```bash
bun install --frozen-lockfile
bun run scripts/bootstrap-doctor.ts
```

Key evidence:

```text
456 packages installed [369.00ms]
Bootstrap doctor passed (12 readiness gates).
```

## Outcome

The E0 rollback/recovery drill passed end to end:

- preflight remained green
- frozen reinstall succeeded after removing generated state
- bootstrap doctor returned to green after recovery
- no guardrail weakening or manual bypasses were required
