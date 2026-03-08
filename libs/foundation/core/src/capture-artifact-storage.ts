import { Schema } from "effect";
import { type ArtifactVisibility } from "./budget-lease-artifact.ts";
import { type ArtifactMetadataRecord } from "./config-storage.ts";
import { StorageLocatorSchema } from "./config-storage.ts";
import { type CanonicalIdentifier } from "./schema-primitives.ts";

export function captureArtifactNamespace(
  targetId: CanonicalIdentifier,
  visibility: ArtifactVisibility,
) {
  return visibility === "raw" ? `captures/raw/${targetId}` : `captures/redacted/${targetId}`;
}

export function captureArtifactNamespacePrefix(visibility: ArtifactVisibility) {
  return visibility === "raw" ? "captures/raw/" : "captures/redacted/";
}

export function buildCaptureStorageLocator(input: {
  readonly targetId: CanonicalIdentifier;
  readonly runId: CanonicalIdentifier;
  readonly keySuffix: string;
  readonly visibility: ArtifactVisibility;
}) {
  return Schema.decodeUnknownSync(StorageLocatorSchema)({
    namespace: captureArtifactNamespace(input.targetId, input.visibility),
    key: `${input.runId}/${input.keySuffix}`,
  });
}

export function enforceCaptureArtifactBoundary(
  artifact: Pick<ArtifactMetadataRecord, "artifactId" | "visibility" | "locator">,
) {
  const expectedPrefix = captureArtifactNamespacePrefix(artifact.visibility);
  if (!artifact.locator.namespace.startsWith(expectedPrefix)) {
    throw new Error(
      `Artifact ${artifact.artifactId} violates the raw/redacted storage boundary for ${artifact.visibility} payloads.`,
    );
  }
}
