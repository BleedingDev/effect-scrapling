import { stat } from "node:fs/promises";
import { join } from "node:path";

const requiredDirectories = [
  ".sf/packs",
  ".sf/fixtures",
  ".sf/baselines",
  ".sf/policies",
  ".sf/targets",
] as const;

async function directoryExists(relativePath: string): Promise<boolean> {
  try {
    const status = await stat(join(process.cwd(), relativePath));
    return status.isDirectory();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const missing: string[] = [];

  for (const relativePath of requiredDirectories) {
    if (!(await directoryExists(relativePath))) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    console.error("Missing required .sf directories:");
    for (const relativePath of missing) {
      console.error(`- ${relativePath}`);
    }
    process.exit(1);
  }

  console.log("sf-assets validation passed.");
}

await main();
