import { describe, expect, it } from "@effect-native/bun-test";
import {
  createActivatedProxyTransportBinding,
  createActivatedTorTransportBinding,
  createActivatedWireGuardTransportBinding,
  deriveActivatedTransportBinding,
  resolveTransportBinding,
  toBrowserTransportProxyConfig,
  toFetchTransportProxyConfig,
} from "../../src/sdk/access-transport-binding.ts";

describe("sdk access transport binding", () => {
  it("derives a direct binding from direct route metadata", () => {
    expect(
      deriveActivatedTransportBinding({
        routeKind: "direct",
        routeConfig: {
          kind: "direct",
        },
      }),
    ).toEqual({
      kind: "direct",
      routeKind: "direct",
      diagnostics: {
        routeKind: "direct",
        routeConfigKind: "direct",
      },
    });
  });

  it("adapts proxy bindings into fetch and browser proxy config", () => {
    const binding = createActivatedProxyTransportBinding({
      routeKind: "http-connect",
      proxyUrl: "http://user:pass@proxy.example.test:8080",
      proxyHeaders: {
        "Proxy-Authorization": "Bearer token",
      },
      bypass: "localhost",
    });

    expect(toFetchTransportProxyConfig(binding)).toEqual({
      url: "http://user:pass@proxy.example.test:8080",
      headers: {
        "Proxy-Authorization": "Bearer token",
      },
    });
    expect(toBrowserTransportProxyConfig(binding)).toEqual({
      server: "http://proxy.example.test:8080/",
      username: "user",
      password: "pass",
      bypass: "localhost",
    });
  });

  it("treats tor as a first-class transport binding instead of a generic proxy alias", () => {
    const binding = createActivatedTorTransportBinding({
      proxyUrl: "socks5://127.0.0.1:9050",
      bypass: "localhost",
    });

    expect(binding).toEqual({
      kind: "tor",
      routeKind: "tor",
      proxyUrl: "socks5://127.0.0.1:9050",
      bypass: "localhost",
      diagnostics: {
        routeKind: "tor",
      },
    });
    expect(
      deriveActivatedTransportBinding({
        routeKind: "tor",
        routeConfig: {
          kind: "tor",
          proxyUrl: "socks5://127.0.0.1:9050",
        },
      }),
    ).toMatchObject({
      kind: "tor",
      routeKind: "tor",
      proxyUrl: "socks5://127.0.0.1:9050",
    });
    expect(toFetchTransportProxyConfig(binding)).toBe("socks5://127.0.0.1:9050");
    expect(toBrowserTransportProxyConfig(binding)).toEqual({
      server: "socks5://127.0.0.1:9050",
      bypass: "localhost",
    });
    expect(
      deriveActivatedTransportBinding({
        routeKind: "tor",
        routeConfig: {
          kind: "tor",
        },
      }),
    ).toEqual({
      kind: "tor",
      routeKind: "tor",
      diagnostics: {
        routeKind: "tor",
        routeConfigKind: "tor",
      },
    });
  });

  it("prefers explicit activated wireguard bindings over legacy route metadata", () => {
    const resolved = resolveTransportBinding({
      binding: createActivatedWireGuardTransportBinding({
        endpoint: "wg://edge-a",
        interfaceName: "wg0",
        proxyUrl: "socks5://127.0.0.1:9050",
      }),
      routeConfig: {
        kind: "wireguard",
        endpoint: "wg://legacy",
      },
    });

    expect(resolved).toMatchObject({
      kind: "wireguard",
      routeKind: "wireguard",
      endpoint: "wg://edge-a",
      interfaceName: "wg0",
      proxyUrl: "socks5://127.0.0.1:9050",
    });
    expect(toFetchTransportProxyConfig(resolved)).toBe("socks5://127.0.0.1:9050");
  });

  it("allows native wireguard bindings without forcing a proxy bridge at activation time", () => {
    const binding = createActivatedWireGuardTransportBinding({
      endpoint: "wg://edge-native",
      interfaceName: "wg-native0",
      exitNodeId: "exit-edge-native",
    });

    expect(binding).toEqual({
      kind: "wireguard",
      routeKind: "wireguard",
      endpoint: "wg://edge-native",
      interfaceName: "wg-native0",
      exitNodeId: "exit-edge-native",
      diagnostics: {
        routeKind: "wireguard",
      },
    });
    expect(toFetchTransportProxyConfig(binding)).toBeUndefined();
    expect(toBrowserTransportProxyConfig(binding)).toBeUndefined();
  });

  it("keeps wireguard route kinds fail-closed even when no routeConfig is present", () => {
    expect(
      resolveTransportBinding({
        routeKind: "wireguard",
      }),
    ).toEqual({
      kind: "wireguard",
      routeKind: "wireguard",
      diagnostics: {
        routeKind: "wireguard",
        routeConfigKind: "wireguard",
      },
    });
  });

  it("hydrates partial wireguard bindings from routeConfig bridge metadata", () => {
    expect(
      resolveTransportBinding({
        binding: {
          kind: "wireguard",
          routeKind: "wireguard",
          endpoint: "wg://edge-a",
          diagnostics: {
            routeKind: "wireguard",
          },
        },
        routeKind: "wireguard",
        routeConfig: {
          kind: "wireguard",
          endpoint: "wg://legacy-edge-a",
          proxyUrl: "socks5://127.0.0.1:9050",
          bypass: "localhost",
        },
      }),
    ).toEqual({
      kind: "wireguard",
      routeKind: "wireguard",
      endpoint: "wg://edge-a",
      proxyUrl: "socks5://127.0.0.1:9050",
      bypass: "localhost",
      diagnostics: {
        routeKind: "wireguard",
        routeConfigKind: "wireguard",
      },
    });
  });
});
