import {
  parseProxyUrl,
  type AccessEgressRouteConfig,
  type BrowserLaunchProxyConfig,
  type BunFetchProxyConfig,
} from "./egress-route-config.ts";

export type ActivatedDirectTransportBinding = {
  readonly kind: "direct";
  readonly routeKind: string;
  readonly diagnostics: Readonly<Record<string, unknown>>;
};

export type ActivatedProxyTransportBinding = {
  readonly kind: "proxy";
  readonly routeKind: string;
  readonly proxyUrl: string;
  readonly proxyHeaders?: Readonly<Record<string, string>> | undefined;
  readonly bypass?: string | undefined;
  readonly diagnostics: Readonly<Record<string, unknown>>;
};

export type ActivatedTorTransportBinding = {
  readonly kind: "tor";
  readonly routeKind: "tor";
  readonly proxyUrl?: string | undefined;
  readonly proxyHeaders?: Readonly<Record<string, string>> | undefined;
  readonly bypass?: string | undefined;
  readonly diagnostics: Readonly<Record<string, unknown>>;
};

export type ActivatedWireGuardTransportBinding = {
  readonly kind: "wireguard";
  readonly routeKind: "wireguard";
  readonly endpoint?: string | undefined;
  readonly interfaceName?: string | undefined;
  readonly exitNodeId?: string | undefined;
  readonly proxyUrl?: string | undefined;
  readonly proxyHeaders?: Readonly<Record<string, string>> | undefined;
  readonly bypass?: string | undefined;
  readonly diagnostics: Readonly<Record<string, unknown>>;
};

export type ActivatedTransportBinding =
  | ActivatedDirectTransportBinding
  | ActivatedProxyTransportBinding
  | ActivatedTorTransportBinding
  | ActivatedWireGuardTransportBinding;

export type AccessTransportBinding = ActivatedTransportBinding;
export type DirectTransportBinding = ActivatedDirectTransportBinding;
export type ProxyTransportBinding = ActivatedProxyTransportBinding;
export type TorTransportBinding = ActivatedTorTransportBinding;
export type WireGuardTransportBinding = ActivatedWireGuardTransportBinding;

function nonEmptyRecord(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) {
    return undefined;
  }

  return Object.keys(headers).length === 0 ? undefined : headers;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractProxyShape(
  routeConfig: AccessEgressRouteConfig | undefined,
): Omit<ActivatedProxyTransportBinding, "kind" | "routeKind" | "diagnostics"> | undefined {
  const proxyUrl = asNonEmptyString(routeConfig?.proxyUrl);
  if (proxyUrl === undefined) {
    return undefined;
  }

  return {
    proxyUrl,
    ...(nonEmptyRecord(routeConfig?.proxyHeaders) === undefined
      ? {}
      : { proxyHeaders: nonEmptyRecord(routeConfig?.proxyHeaders) }),
    ...(asNonEmptyString(routeConfig?.bypass) === undefined
      ? {}
      : { bypass: asNonEmptyString(routeConfig?.bypass) }),
  };
}

export function createActivatedProxyTransportBinding(input: {
  readonly routeKind: string;
  readonly proxyUrl: string;
  readonly proxyHeaders?: Readonly<Record<string, string>> | undefined;
  readonly bypass?: string | undefined;
  readonly diagnostics?: Readonly<Record<string, unknown>> | undefined;
}): ActivatedProxyTransportBinding {
  return {
    kind: "proxy",
    routeKind: input.routeKind,
    proxyUrl: input.proxyUrl,
    ...(nonEmptyRecord(input.proxyHeaders) === undefined
      ? {}
      : { proxyHeaders: nonEmptyRecord(input.proxyHeaders) }),
    ...(asNonEmptyString(input.bypass) === undefined
      ? {}
      : { bypass: asNonEmptyString(input.bypass) }),
    diagnostics: {
      routeKind: input.routeKind,
      ...input.diagnostics,
    },
  };
}

export function createActivatedTorTransportBinding(input: {
  readonly proxyUrl?: string | undefined;
  readonly proxyHeaders?: Readonly<Record<string, string>> | undefined;
  readonly bypass?: string | undefined;
  readonly diagnostics?: Readonly<Record<string, unknown>> | undefined;
}): ActivatedTorTransportBinding {
  return {
    kind: "tor",
    routeKind: "tor",
    ...(asNonEmptyString(input.proxyUrl) === undefined
      ? {}
      : { proxyUrl: asNonEmptyString(input.proxyUrl) }),
    ...(nonEmptyRecord(input.proxyHeaders) === undefined
      ? {}
      : { proxyHeaders: nonEmptyRecord(input.proxyHeaders) }),
    ...(asNonEmptyString(input.bypass) === undefined
      ? {}
      : { bypass: asNonEmptyString(input.bypass) }),
    diagnostics: {
      routeKind: "tor",
      ...input.diagnostics,
    },
  };
}

export function createActivatedWireGuardTransportBinding(input: {
  readonly proxyUrl: string;
  readonly proxyHeaders?: Readonly<Record<string, string>> | undefined;
  readonly bypass?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly interfaceName?: string | undefined;
  readonly exitNodeId?: string | undefined;
  readonly diagnostics?: Readonly<Record<string, unknown>> | undefined;
}): ActivatedWireGuardTransportBinding {
  return {
    kind: "wireguard",
    routeKind: "wireguard",
    ...(asNonEmptyString(input.endpoint) === undefined
      ? {}
      : { endpoint: asNonEmptyString(input.endpoint) }),
    ...(asNonEmptyString(input.interfaceName) === undefined
      ? {}
      : { interfaceName: asNonEmptyString(input.interfaceName) }),
    ...(asNonEmptyString(input.exitNodeId) === undefined
      ? {}
      : { exitNodeId: asNonEmptyString(input.exitNodeId) }),
    proxyUrl: input.proxyUrl,
    ...(nonEmptyRecord(input.proxyHeaders) === undefined
      ? {}
      : { proxyHeaders: nonEmptyRecord(input.proxyHeaders) }),
    ...(asNonEmptyString(input.bypass) === undefined
      ? {}
      : { bypass: asNonEmptyString(input.bypass) }),
    diagnostics: {
      routeKind: "wireguard",
      ...input.diagnostics,
    },
  };
}

export function deriveActivatedTransportBinding(input: {
  readonly routeKind: string;
  readonly routeConfig?: AccessEgressRouteConfig | undefined;
}): ActivatedTransportBinding {
  const routeKind = input.routeKind;
  const routeConfig = input.routeConfig;
  const proxyShape = extractProxyShape(routeConfig);

  if (routeKind === "wireguard" || routeConfig?.kind === "wireguard") {
    return {
      kind: "wireguard",
      routeKind: "wireguard",
      ...(asNonEmptyString(routeConfig?.endpoint) === undefined
        ? {}
        : { endpoint: asNonEmptyString(routeConfig?.endpoint) }),
      ...(asNonEmptyString(routeConfig?.interfaceName) === undefined
        ? {}
        : { interfaceName: asNonEmptyString(routeConfig?.interfaceName) }),
      ...(asNonEmptyString(routeConfig?.exitNodeId) === undefined
        ? {}
        : { exitNodeId: asNonEmptyString(routeConfig?.exitNodeId) }),
      ...(proxyShape === undefined ? {} : proxyShape),
      diagnostics: {
        routeKind,
        routeConfigKind: routeConfig?.kind ?? routeKind,
      },
    };
  }

  if (routeKind === "tor" || routeConfig?.kind === "tor") {
    if (proxyShape === undefined) {
      return {
        kind: "tor",
        routeKind: "tor",
        diagnostics: {
          routeKind,
          routeConfigKind: routeConfig?.kind ?? routeKind,
        },
      };
    }

    return {
      kind: "tor",
      routeKind: "tor",
      ...proxyShape,
      diagnostics: {
        routeKind,
        routeConfigKind: routeConfig?.kind ?? routeKind,
      },
    };
  }

  if (proxyShape !== undefined) {
    return {
      kind: "proxy",
      routeKind,
      ...proxyShape,
      diagnostics: {
        routeKind,
        routeConfigKind: routeConfig?.kind ?? routeKind,
      },
    };
  }

  return {
    kind: "direct",
    routeKind,
    diagnostics: {
      routeKind,
      routeConfigKind: routeConfig?.kind ?? routeKind,
    },
  };
}

export function resolveTransportBinding(input: {
  readonly binding?: ActivatedTransportBinding | undefined;
  readonly routeKind?: string | undefined;
  readonly routeConfig?: AccessEgressRouteConfig | undefined;
}): ActivatedTransportBinding {
  const derived = deriveActivatedTransportBinding({
    routeKind: input.routeKind ?? input.routeConfig?.kind ?? input.binding?.routeKind ?? "direct",
    routeConfig: input.routeConfig,
  });
  if (input.binding === undefined) {
    return derived;
  }

  if (input.binding.kind === "wireguard" && derived.kind === "wireguard") {
    return {
      ...derived,
      ...input.binding,
      ...(input.binding.endpoint === undefined ? {} : { endpoint: input.binding.endpoint }),
      ...(input.binding.interfaceName === undefined
        ? {}
        : { interfaceName: input.binding.interfaceName }),
      ...(input.binding.exitNodeId === undefined ? {} : { exitNodeId: input.binding.exitNodeId }),
      ...(input.binding.proxyUrl === undefined ? {} : { proxyUrl: input.binding.proxyUrl }),
      ...(input.binding.proxyHeaders === undefined
        ? {}
        : { proxyHeaders: input.binding.proxyHeaders }),
      ...(input.binding.bypass === undefined ? {} : { bypass: input.binding.bypass }),
      diagnostics: {
        ...derived.diagnostics,
        ...input.binding.diagnostics,
      },
    };
  }

  if (input.binding.kind === "proxy" && derived.kind === "proxy") {
    return {
      ...derived,
      ...input.binding,
      ...(input.binding.proxyHeaders === undefined
        ? {}
        : { proxyHeaders: input.binding.proxyHeaders }),
      ...(input.binding.bypass === undefined ? {} : { bypass: input.binding.bypass }),
      diagnostics: {
        ...derived.diagnostics,
        ...input.binding.diagnostics,
      },
    };
  }

  if (input.binding.kind === "tor" && derived.kind === "tor") {
    return {
      ...derived,
      ...input.binding,
      ...(input.binding.proxyHeaders === undefined
        ? {}
        : { proxyHeaders: input.binding.proxyHeaders }),
      ...(input.binding.bypass === undefined ? {} : { bypass: input.binding.bypass }),
      diagnostics: {
        ...derived.diagnostics,
        ...input.binding.diagnostics,
      },
    };
  }

  return input.binding;
}

export function transportBindingFromRouteConfig(
  routeConfig: AccessEgressRouteConfig | undefined,
): ActivatedTransportBinding | undefined {
  if (routeConfig === undefined) {
    return undefined;
  }

  return deriveActivatedTransportBinding({
    routeKind: routeConfig.kind,
    routeConfig,
  });
}

export function toFetchTransportProxyConfig(
  binding: ActivatedTransportBinding | undefined,
): BunFetchProxyConfig | undefined {
  if (binding === undefined || binding.kind === "direct") {
    return undefined;
  }

  const proxyUrl =
    binding.kind === "proxy" || binding.kind === "tor"
      ? binding.proxyUrl
      : asNonEmptyString(binding.proxyUrl);
  if (proxyUrl === undefined) {
    return undefined;
  }

  const headers = nonEmptyRecord(binding.proxyHeaders);
  return headers === undefined
    ? proxyUrl
    : {
        url: proxyUrl,
        headers,
      };
}

export function toBrowserTransportProxyConfig(
  binding: ActivatedTransportBinding | undefined,
): BrowserLaunchProxyConfig | undefined {
  if (binding === undefined || binding.kind === "direct") {
    return undefined;
  }

  const proxyUrl =
    binding.kind === "proxy" || binding.kind === "tor"
      ? binding.proxyUrl
      : asNonEmptyString(binding.proxyUrl);
  if (proxyUrl === undefined) {
    return undefined;
  }

  const parsed = parseProxyUrl(proxyUrl);
  const username = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined;
  parsed.username = "";
  parsed.password = "";

  const bypass =
    binding.kind === "proxy" || binding.kind === "tor"
      ? binding.bypass
      : asNonEmptyString(binding.bypass);

  return {
    server: parsed.toString(),
    ...(bypass === undefined ? {} : { bypass }),
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
}

export const toBunFetchTransportConfig = toFetchTransportProxyConfig;
export const toBrowserLaunchTransportConfig = toBrowserTransportProxyConfig;

export function describeUnsupportedProxyExecution(
  binding: ActivatedTransportBinding | undefined,
  url: string,
): string | undefined {
  if (binding === undefined || binding.kind === "direct") {
    return undefined;
  }

  if (asNonEmptyString(binding.proxyUrl) !== undefined) {
    return undefined;
  }

  return `Transport binding "${binding.kind}" for ${url} did not expose a proxy-capable bridge. The current HTTP/browser execution providers require a realized proxy-capable transport binding instead of silently falling back to direct access.`;
}
