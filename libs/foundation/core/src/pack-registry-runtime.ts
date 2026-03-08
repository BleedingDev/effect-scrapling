import { Effect, Layer, Option, Schema } from "effect";
import { PackRegistry } from "./service-topology.ts";
import { PackRegistryLookup, SitePack, SitePackSchema, comparePackVersions } from "./site-pack.ts";
import type { PackRegistryLookupState } from "./site-pack.ts";

export const PackRegistryCatalogSchema = Schema.Array(SitePackSchema).pipe(
  Schema.refine(
    (packs): packs is ReadonlyArray<SitePack> =>
      new Set(packs.map(({ id }) => id)).size === packs.length,
    {
      message: "Expected a pack registry catalog with unique pack identifiers.",
    },
  ),
);

function decodeLookup(input: string | PackRegistryLookup) {
  return typeof input === "string"
    ? Schema.decodeUnknownSync(PackRegistryLookup)({
        domain: input,
      })
    : Schema.decodeUnknownSync(PackRegistryLookup)(input);
}

function matchesDomainPattern(pattern: string, domain: string) {
  if (pattern === domain) {
    return true;
  }

  if (!pattern.startsWith("*.")) {
    return false;
  }

  const suffix = pattern.slice(2);
  return domain.endsWith(`.${suffix}`);
}

function statePreferenceIndex(
  requestedStates: ReadonlyArray<PackRegistryLookupState>,
  state: SitePack["state"],
) {
  const index = requestedStates.indexOf(state);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

function tenantPreference(
  requestedTenantId: SitePack["tenantId"],
  candidateTenantId: SitePack["tenantId"],
) {
  if (requestedTenantId === undefined) {
    return candidateTenantId === undefined ? 0 : 1;
  }

  if (candidateTenantId === requestedTenantId) {
    return 0;
  }

  return candidateTenantId === undefined ? 1 : 2;
}

function domainSpecificity(pattern: SitePack["domainPattern"]) {
  if (!pattern.startsWith("*.")) {
    return 10_000 + pattern.length;
  }

  return pattern.slice(2).split(".").length * 100 + pattern.length;
}

function compareCatalogCandidates(lookup: PackRegistryLookup, left: SitePack, right: SitePack) {
  const stateDelta =
    statePreferenceIndex(lookup.states, left.state) -
    statePreferenceIndex(lookup.states, right.state);
  if (stateDelta !== 0) {
    return stateDelta;
  }

  const tenantDelta =
    tenantPreference(lookup.tenantId, left.tenantId) -
    tenantPreference(lookup.tenantId, right.tenantId);
  if (tenantDelta !== 0) {
    return tenantDelta;
  }

  const specificityDelta =
    domainSpecificity(right.domainPattern) - domainSpecificity(left.domainPattern);
  if (specificityDelta !== 0) {
    return specificityDelta;
  }

  const versionDelta = comparePackVersions(right.version, left.version);
  if (versionDelta !== 0) {
    return versionDelta;
  }

  return left.id.localeCompare(right.id);
}

export function resolvePackRegistryLookup(
  catalog: ReadonlyArray<SitePack>,
  lookupInput: string | PackRegistryLookup,
) {
  const lookup = decodeLookup(lookupInput);
  const candidates = catalog
    .filter(
      (pack) =>
        matchesDomainPattern(pack.domainPattern, lookup.domain) &&
        statePreferenceIndex(lookup.states, pack.state) !== Number.POSITIVE_INFINITY &&
        tenantPreference(lookup.tenantId, pack.tenantId) < 2,
    )
    .sort((left, right) => compareCatalogCandidates(lookup, left, right));

  const candidate = candidates[0];
  return candidate === undefined ? Option.none() : Option.some(candidate);
}

export function makePackRegistry(catalogInput: unknown) {
  const catalog = Schema.decodeUnknownSync(PackRegistryCatalogSchema)(catalogInput);

  return PackRegistry.of({
    getByDomain: (domain) => Effect.succeed(resolvePackRegistryLookup(catalog, domain)),
    getById: (packId) => {
      const pack = catalog.find((candidate) => candidate.id === packId);
      return Effect.succeed(pack === undefined ? Option.none() : Option.some(pack));
    },
  });
}

export function makePackRegistryLayer(catalogInput: unknown) {
  return Layer.succeed(PackRegistry)(makePackRegistry(catalogInput));
}
