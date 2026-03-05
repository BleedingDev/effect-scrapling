# effect-scrapling

Issue-tracking workspace using `bd` (Dolt-backed) as the source of truth, with a `br` SQLite mirror for compatibility with tools that expect `br`.

## Core Model

- Canonical data source: `bd`
- Compatibility mirror: `br`
- Sync direction: `bd -> .beads/issues.jsonl -> br`

`br` is treated as a rebuildable mirror, not the authoritative write path.

## Standalone Mode

Use this repo directly as your tracker workspace.

### Prerequisites

- `bun >= 1.3.10`
- `bd` CLI
- `br` CLI
- `jq`

### First Run

```bash
git clone https://github.com/BleedingDev/effect-scrapling.git
cd effect-scrapling
scripts/beads-stabilize.sh
```

### Daily Workflow

1. Create/update issues with `bd`.
2. Run stabilization to keep `br` parity.
3. Use either `bd` or `br` for reads/reporting.

Write examples:

```bash
bd create "Implement X" --description "..." -t task -p 1 --json
bd update bd-123 --status in_progress --json
bd close bd-123 --reason "Done" --json
scripts/beads-stabilize.sh
```

Read examples:

```bash
bd ready --json
br list --json
br graph --json
```

### Health Checks

```bash
bd doctor
br doctor
br dep cycles
```

If foreign issue prefixes are detected (non-`bd-*`), review and purge explicitly:

```bash
scripts/beads-stabilize.sh --purge-foreign --yes
```

The script writes detected foreign IDs to:

```text
.beads/foreign-ids.pending.txt
```

## Library Mode (Use Inside Other Tools)

There is no SDK package in this repository. "Library mode" means integrating through CLI calls from your own app/tool.

### Integration Pattern

1. Your tool performs writes via `bd` (`create`, `update`, `close`, etc.).
2. Your tool calls `scripts/beads-stabilize.sh`.
3. Your tool reads from `bd --json ...` or `br --json ...`.

### Node.js Example

```js
import { execFileSync } from "node:child_process";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

run("bd", ["create", "Library-created task", "--description", "From host tool", "-t", "task", "-p", "2", "--json"]);
run("scripts/beads-stabilize.sh", []);

const ready = JSON.parse(run("bd", ["ready", "--json"]));
console.log(ready);
```

### Python Example

```python
import json
import subprocess

def run(*args):
    return subprocess.check_output(args, text=True)

run("bd", "create", "Python-created task", "--description", "From host tool", "-t", "task", "-p", "2", "--json")
run("scripts/beads-stabilize.sh")

ready = json.loads(run("bd", "ready", "--json"))
print(ready)
```

## Script Contract

`scripts/beads-stabilize.sh` guarantees:

- Export canonical issue set from `bd` to configured JSONL path.
- Refresh `bd` import timestamp metadata to avoid stale-read lockouts.
- Rebuild `br` SQLite mirror from JSONL.
- Verify count parity between `bd` and `br`.
- Run `br doctor` and dependency cycle checks.

Non-zero exits indicate actionable sync/consistency failures.
