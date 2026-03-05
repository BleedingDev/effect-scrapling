import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

type PackageJson = {
  version?: string;
};

const pkgPath = path.resolve(process.cwd(), "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;

const version = pkg.version;
if (!version) {
  console.error("Missing version in package.json");
  process.exit(1);
}

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const match = semver.exec(version);

if (!match) {
  console.error(`Invalid semver version in package.json: ${version}`);
  process.exit(1);
}

const major = Number(match[1]);
const allowV1Override = process.env.ALLOW_V1_RELEASE === "1";

const localTagCheck = spawnSync("git", ["rev-parse", "-q", "--verify", "refs/tags/v1.0.0"], {
  encoding: "utf8",
});
const localV1TagExists = localTagCheck.status === 0;

let remoteV1TagExists = false;
if (!localV1TagExists) {
  const remoteTagCheck = spawnSync("git", ["ls-remote", "--tags", "--refs", "origin", "v1.0.0"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  remoteV1TagExists = remoteTagCheck.status === 0 && remoteTagCheck.stdout.trim().length > 0;
}

const v1Released = localV1TagExists || remoteV1TagExists;

if (major > 0 && !allowV1Override && !v1Released) {
  console.error(
    `Version ${version} is not allowed by pre-1.0 policy. ` +
      "Until the first stable release (v1.0.0), version must stay in major 0 " +
      "(0.0.x or 0.x.y). Set ALLOW_V1_RELEASE=1 only for the manual v1 release workflow.",
  );
  process.exit(1);
}

const reason = allowV1Override
  ? "manual v1 override"
  : localV1TagExists
    ? "v1.0.0 tag present locally"
    : remoteV1TagExists
      ? "v1.0.0 tag found on origin"
      : "pre-1.0 policy";

console.log(`Version policy OK: ${version} (${reason})`);
