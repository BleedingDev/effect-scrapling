export const PREFERRED_PATH_OVERRIDE_WARNING_PREFIXES = {
  egress: 'Selection policy chose egress "',
  identity: 'Selection policy chose identity "',
  provider: 'Selection policy chose provider "',
} as const;

export type PreferredPathOverrideKind = keyof typeof PREFERRED_PATH_OVERRIDE_WARNING_PREFIXES;

export function makePreferredPathOverrideWarning(input: {
  readonly kind: PreferredPathOverrideKind;
  readonly selectedId: string;
  readonly preferredId: string;
}) {
  switch (input.kind) {
    case "egress":
      return `Selection policy chose egress "${input.selectedId}" instead of preferred "${input.preferredId}"; access health signals rate the preferred path as less healthy.`;
    case "identity":
      return `Selection policy chose identity "${input.selectedId}" instead of preferred "${input.preferredId}"; access health signals rate the preferred path as less healthy.`;
    case "provider":
      return `Selection policy chose provider "${input.selectedId}" instead of preferred "${input.preferredId}"; access health signals rate the preferred provider as less healthy.`;
  }
}

export function parsePreferredPathOverrideWarning(
  warning: string,
): PreferredPathOverrideKind | undefined {
  for (const [kind, prefix] of Object.entries(
    PREFERRED_PATH_OVERRIDE_WARNING_PREFIXES,
  ) as ReadonlyArray<readonly [PreferredPathOverrideKind, string]>) {
    if (warning.startsWith(prefix)) {
      return kind;
    }
  }

  return undefined;
}
