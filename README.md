# effect-scrapling

Tooling package that ships two executable modes:

- `standalone`: CLI binary for status/sync/doctor actions
- `api`: HTTP server binary exposing health/status/sync endpoints

Both are built as single-file executables (SFE) in GitHub Actions for multiple platforms.

## Prerequisites

- `bun >= 1.3.10`
- `bd` CLI
- `br` CLI
- `jq`

## Versioning Policy (Pre-1.0)

Until the first manual stable release, versions must stay in major `0`:

- `0.0.x`
- `0.x.y`

CI enforces this with:

- `bun run check:semver`
- `bun run check:publint`

After `v1.0.0` exists, the pre-1.0 major-zero restriction is automatically lifted.

## Local Usage

### Run as standalone CLI

```bash
bun run standalone --help
bun run standalone status
bun run standalone sync
bun run standalone doctor
```

### Run as API server

```bash
PORT=3000 bun run api
```

Available endpoints:

- `GET /health` -> process health
- `GET /status` -> `bd`/`br` counts + parity
- `POST /sync` -> run stabilization flow

## Build Single-File Executables Locally

```bash
mkdir -p dist
bun build --compile --target=bun-linux-x64 src/standalone.ts --outfile dist/standalone-bun-linux-x64
bun build --compile --target=bun-linux-x64 src/api.ts --outfile dist/api-bun-linux-x64
```

For Windows target names, use `.exe` output files.

## GitHub Actions + Releases (Multi-Platform)

Workflow: `.github/workflows/build-sfe.yml`

Build matrix targets:

- `bun-linux-x64`
- `bun-linux-arm64`
- `bun-darwin-x64`
- `bun-darwin-arm64`
- `bun-windows-x64`

For each target, the workflow uploads artifacts containing:

- `standalone-<target>[.exe]`
- `api-<target>[.exe]`

### Release publishing

Release publishing is manual and explicit.

1. Create and push a tag that matches `package.json` version:

```bash
git tag v0.0.1
git push origin v0.0.1
```

2. Open Actions -> `build-sfe` -> `Run workflow` and set:

- `publish_release=true`
- `release_tag=v<package.json version>` (example: `v0.0.1`)
- `allow_v1=true` only for the first manual `>=1.0.0` release

The workflow creates/updates a GitHub Release for that tag with zip assets:

- `sfe-bun-linux-x64.zip`
- `sfe-bun-linux-arm64.zip`
- `sfe-bun-darwin-x64.zip`
- `sfe-bun-darwin-arm64.zip`
- `sfe-bun-windows-x64.zip`

## Use as a Library Inside Other Tools

This repository is integrated as an executable dependency (process-level integration).

### Integration pattern

1. Call `standalone status` for health/parity.
2. Call `standalone sync` before reads that need fresh mirror state.
3. Use the API binary when you want long-running service mode.

### Node.js example

```js
import { execFileSync } from "node:child_process";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

const status = JSON.parse(run("./standalone", ["status"]));
if (!status.parity) run("./standalone", ["sync"]);
```

### Python example

```python
import json
import subprocess

status = json.loads(subprocess.check_output(["./standalone", "status"], text=True))
if not status["parity"]:
    subprocess.check_call(["./standalone", "sync"])
```

## Notes

- Sync uses `scripts/beads-stabilize.sh`.
- If foreign prefixes are detected, run:

```bash
scripts/beads-stabilize.sh --purge-foreign --yes
```
