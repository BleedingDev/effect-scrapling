import { DEFAULT_BROWSER_PROVIDER_ID, DEFAULT_HTTP_PROVIDER_ID } from "./access-provider-ids.ts";
import { type AccessMode, type AccessProviderId } from "./schemas.ts";

function resolvePreferredProviderId(input: {
  readonly providerIds: ReadonlyArray<AccessProviderId>;
  readonly preferredProviderId: AccessProviderId;
}) {
  return input.providerIds.includes(input.preferredProviderId)
    ? input.preferredProviderId
    : input.providerIds[0];
}

export function resolveModeDefaultProviderId(input: {
  readonly mode: AccessMode;
  readonly providerIds: ReadonlyArray<AccessProviderId>;
}) {
  return resolvePreferredProviderId({
    providerIds: input.providerIds,
    preferredProviderId:
      input.mode === "browser" ? DEFAULT_BROWSER_PROVIDER_ID : DEFAULT_HTTP_PROVIDER_ID,
  });
}
