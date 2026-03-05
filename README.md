# effect-scrapling

`effect-scrapling` is a tool for keeping `bd` and `br` in sync.
It provides two runtime modes:

- `standalone`: command-line mode
- `api`: HTTP service mode

## Requirements

- `bun >= 1.3.10`
- `bd` CLI available on `PATH`
- `br` CLI available on `PATH`

## Standalone Mode

### Run from source

```bash
bun run standalone help
bun run standalone status
bun run standalone sync
bun run standalone doctor
```

### Commands

- `help`: print usage
- `status`: return JSON with `bdCount`, `brCount`, and `parity`
- `sync`: run stabilization to align `bd` and `br`
- `doctor`: run health checks for both CLIs

## API Mode

### Run from source

```bash
PORT=3000 bun run api
```

### Endpoints

- `GET /health`: service liveness
- `GET /status`: JSON parity/status (`bdCount`, `brCount`, `parity`)
- `POST /sync`: run stabilization

## Use in Other Tools (Library-Style Integration)

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
