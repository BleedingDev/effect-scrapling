import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  AccessExecutionMetadataSchema,
  AccessExecutionProfileSchema,
  AccessPreviewRequestSchema,
} from "../../src/sdk/schemas.ts";

describe("sdk schemas", () => {
  it("decodes the canonical execution contract with nested profiles", () => {
    expect(
      Schema.decodeUnknownSync(AccessPreviewRequestSchema)({
        url: "https://example.com/products/sku-42",
        timeoutMs: "1200",
        execution: {
          mode: " browser ",
          providerId: " browser-stealth ",
          egress: {
            profileId: " direct ",
          },
          identity: {
            profileId: " stealth-default ",
          },
          browserRuntimeProfileId: " patchright-stealth ",
          http: {
            userAgent: " HTTP Agent ",
          },
          browser: {
            waitUntil: " commit ",
            timeoutMs: "900",
            userAgent: " Browser Agent ",
          },
          fallback: {
            browserOnAccessWall: " true ",
          },
        },
      }),
    ).toEqual({
      url: "https://example.com/products/sku-42",
      timeoutMs: 1200,
      execution: {
        mode: "browser",
        providerId: "browser-stealth",
        egress: {
          profileId: "direct",
          pluginConfig: undefined,
        },
        identity: {
          profileId: "stealth-default",
          pluginConfig: undefined,
        },
        browserRuntimeProfileId: "patchright-stealth",
        http: {
          userAgent: "HTTP Agent",
        },
        browser: {
          waitUntil: "commit",
          timeoutMs: 900,
          userAgent: "Browser Agent",
        },
        fallback: {
          browserOnAccessWall: true,
        },
      },
    });
  });

  it("accepts custom provider identifiers for plugin-defined runtimes", () => {
    expect(
      Schema.decodeUnknownSync(AccessExecutionProfileSchema)({
        mode: "browser",
        providerId: "managed-unblocker",
      }),
    ).toEqual({
      mode: "browser",
      providerId: "managed-unblocker",
    });
  });

  it("decodes execution metadata envelopes with custom provider and route identifiers", () => {
    expect(
      Schema.decodeUnknownSync(AccessExecutionMetadataSchema)({
        providerId: "managed-unblocker",
        mode: "browser",
        egressProfileId: "direct",
        egressPluginId: "builtin-direct-egress",
        egressRouteKind: "residential-proxy",
        egressRouteKey: "direct",
        egressPoolId: "direct",
        egressRoutePolicyId: "direct",
        egressKey: "direct",
        identityProfileId: "default",
        identityPluginId: "builtin-default-identity",
        identityTenantId: "default-tenant",
        identityKey: "default",
        browserRuntimeProfileId: "patchright-default",
        browserPoolKey: "browser-basic::patchright-default::direct::default",
      }),
    ).toEqual({
      providerId: "managed-unblocker",
      mode: "browser",
      egressProfileId: "direct",
      egressPluginId: "builtin-direct-egress",
      egressRouteKind: "residential-proxy",
      egressRouteKey: "direct",
      egressPoolId: "direct",
      egressRoutePolicyId: "direct",
      egressKey: "direct",
      identityProfileId: "default",
      identityPluginId: "builtin-default-identity",
      identityTenantId: "default-tenant",
      identityKey: "default",
      browserRuntimeProfileId: "patchright-default",
      browserPoolKey: "browser-basic::patchright-default::direct::default",
    });
  });
});
