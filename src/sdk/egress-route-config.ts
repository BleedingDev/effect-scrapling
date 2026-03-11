export type AccessEgressRouteConfig = Readonly<Record<string, unknown>> & {
  readonly kind: string;
  readonly proxyUrl?: string | undefined;
  readonly proxyHeaders?: Readonly<Record<string, string>> | undefined;
  readonly bypass?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly interfaceName?: string | undefined;
  readonly exitNodeId?: string | undefined;
};

export type DirectEgressRouteConfig = AccessEgressRouteConfig & {
  readonly kind: "direct";
};

export type WireGuardEgressRouteConfig = AccessEgressRouteConfig & {
  readonly kind: "wireguard";
};

export type ProxyEgressRouteKind = string;

export type ProxyEgressRouteConfig = AccessEgressRouteConfig;

export type BunFetchProxyConfig =
  | string
  | {
      readonly url: string;
      readonly headers?: HeadersInit | undefined;
    };

export type BrowserLaunchProxyConfig = {
  readonly server: string;
  readonly bypass?: string | undefined;
  readonly username?: string | undefined;
  readonly password?: string | undefined;
};

function isProxyRouteConfig(
  routeConfig: AccessEgressRouteConfig | undefined,
): routeConfig is ProxyEgressRouteConfig {
  return typeof routeConfig?.proxyUrl === "string" && routeConfig.proxyUrl.trim().length > 0;
}

function nonEmptyRecord(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) {
    return undefined;
  }

  return Object.keys(headers).length === 0 ? undefined : headers;
}

export function parseProxyUrl(proxyUrl: string) {
  return new URL(proxyUrl);
}

export function toBunFetchProxyConfig(
  routeConfig: AccessEgressRouteConfig | undefined,
): BunFetchProxyConfig | undefined {
  if (!isProxyRouteConfig(routeConfig) || routeConfig.proxyUrl === undefined) {
    return undefined;
  }

  const headers = nonEmptyRecord(routeConfig.proxyHeaders);
  return headers === undefined
    ? routeConfig.proxyUrl
    : {
        url: routeConfig.proxyUrl,
        headers,
      };
}

export function toBrowserLaunchProxyConfig(
  routeConfig: AccessEgressRouteConfig | undefined,
): BrowserLaunchProxyConfig | undefined {
  if (!isProxyRouteConfig(routeConfig) || routeConfig.proxyUrl === undefined) {
    return undefined;
  }

  const parsed = parseProxyUrl(routeConfig.proxyUrl);
  const username = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password.length > 0 ? decodeURIComponent(parsed.password) : undefined;
  parsed.username = "";
  parsed.password = "";

  return {
    server: parsed.toString(),
    ...(routeConfig.bypass === undefined ? {} : { bypass: routeConfig.bypass }),
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
  };
}
