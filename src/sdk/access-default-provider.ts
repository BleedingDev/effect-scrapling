import { type AccessProviderDescriptor } from "./access-provider-runtime.ts";
import { type AccessMode } from "./schemas.ts";

export function resolveModeDefaultProviderId(input: {
  readonly mode: AccessMode;
  readonly providers: ReadonlyArray<AccessProviderDescriptor>;
}) {
  return input.providers
    .filter((provider) => provider.capabilities.mode === input.mode)
    .sort((left, right) => {
      const priorityDifference =
        (right.capabilities.selectionPriority ?? 0) - (left.capabilities.selectionPriority ?? 0);
      return priorityDifference === 0 ? left.id.localeCompare(right.id) : priorityDifference;
    })[0]?.id;
}
