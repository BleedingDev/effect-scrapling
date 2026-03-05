# effect-scrapling

`effect-scrapling` keeps `bd` and `br` synchronized.

There are two executables:

- `effect-scrapling`: command-line tool
- `effect-scrapling-api`: HTTP service

## Runtime Requirements

- `bd` CLI available on `PATH`
- `br` CLI available on `PATH`

`bun` is only needed when you run from source code.
If you use prebuilt binaries from Releases, `bun` is not required.

## Source-Mode Requirement (Optional)

- `bun >= 1.3.10`

## Standalone CLI (`effect-scrapling`)

### Run from binary

```bash
./effect-scrapling help
./effect-scrapling status
./effect-scrapling sync
./effect-scrapling doctor
```

### Run from source (optional)

```bash
bun run src/standalone.ts help
bun run src/standalone.ts status
bun run src/standalone.ts sync
bun run src/standalone.ts doctor
```

### Command reference

- `help`: print usage
- `status`: return JSON with `bdCount`, `brCount`, and `parity`
- `sync`: run stabilization to align `bd` and `br`
- `doctor`: run health checks for both CLIs

## API Service (`effect-scrapling-api`)

### Run from binary

```bash
PORT=3000 ./effect-scrapling-api
```

### Run from source (optional)

```bash
PORT=3000 bun run src/api.ts
```

### Endpoints

- `GET /health`: service liveness
- `GET /status`: JSON parity/status (`bdCount`, `brCount`, `parity`)
- `POST /sync`: run stabilization

## Use Inside Other Tools (Library-Style Integration)

This project is integrated by executing the binaries/processes.

### Typical integration flow

1. Call `status`.
2. If `parity` is `false`, call `sync`.
3. Continue with tool logic only when parity is restored.

### Node.js example

```js
import { execFileSync } from "node:child_process";

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

const status = JSON.parse(run("./effect-scrapling", ["status"]));
if (!status.parity) run("./effect-scrapling", ["sync"]);
```

### Python example

```python
import json
import subprocess

status = json.loads(subprocess.check_output(["./effect-scrapling", "status"], text=True))
if not status["parity"]:
    subprocess.check_call(["./effect-scrapling", "sync"])
```
