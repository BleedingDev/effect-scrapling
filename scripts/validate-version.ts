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

const v1TagCheck = spawnSync("git", ["tag", "--list", "v1.0.0"], {
  encoding: "utf8",
});
const v1Released = v1TagCheck.status === 0 && v1TagCheck.stdout.trim() === "v1.0.0";

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
  : v1Released
    ? "v1.0.0 already released"
    : "pre-1.0 policy";

console.log(`Version policy OK: ${version} (${reason})`);
