import { describe, expect, it } from "@effect-native/bun-test";
import { Effect, Schema } from "effect";
import {
  TargetImportEnvelopeSchema,
  TargetListEnvelopeSchema,
  runTargetImportOperation,
  runTargetListOperation,
} from "effect-scrapling/e8";
import { executeCli } from "../../src/standalone.ts";
import { InvalidInputError } from "../../src/sdk/errors.ts";

function makeTarget(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly domain: string;
  readonly kind: "productPage" | "productListing";
  readonly priority: number;
}) {
  return {
    id: input.id,
    tenantId: input.tenantId,
    domain: input.domain,
    kind: input.kind,
    canonicalKey: `${input.kind}/${input.id}`,
    seedUrls: [`https://${input.domain}/${input.id}`],
    accessPolicyId: "policy-default",
    packId: "pack-shop-example-com",
    priority: input.priority,
  };
}

describe("E8 target verification", () => {
  it.effect("keeps domain and kind filtering deterministic across SDK and CLI", () =>
    Effect.gen(function* () {
      const targets = [
        makeTarget({
          id: "target-shop-product-001",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productPage",
          priority: 30,
        }),
        makeTarget({
          id: "target-shop-listing-001",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productListing",
          priority: 20,
        }),
        makeTarget({
          id: "target-blog-product-001",
          tenantId: "tenant-alt",
          domain: "blog.example.com",
          kind: "productPage",
          priority: 10,
        }),
      ];

      const sdkImport = yield* runTargetImportOperation({ targets });
      const sdkList = yield* runTargetListOperation({
        targets,
        filters: {
          domain: "shop.example.com",
          kind: "productPage",
        },
      });
      const cliList = yield* Effect.promise(() =>
        executeCli([
          "target",
          "list",
          "--input",
          JSON.stringify({
            targets,
            filters: {
              domain: "shop.example.com",
              kind: "productPage",
            },
          }),
        ]),
      );

      expect(
        Schema.decodeUnknownSync(TargetImportEnvelopeSchema)(sdkImport).data.targets.map(
          ({ id }) => id,
        ),
      ).toEqual(["target-blog-product-001", "target-shop-listing-001", "target-shop-product-001"]);
      expect(Schema.decodeUnknownSync(TargetListEnvelopeSchema)(sdkList)).toEqual(
        Schema.decodeUnknownSync(TargetListEnvelopeSchema)(JSON.parse(cliList.output)),
      );
      expect(sdkList.data.count).toBe(1);
      expect(sdkList.data.targets.map(({ id }) => id)).toEqual(["target-shop-product-001"]);
    }),
  );

  it.effect("rejects duplicate catalogs and malformed filters across SDK and CLI", () =>
    Effect.gen(function* () {
      const duplicateTargets = [
        makeTarget({
          id: "target-dup-001",
          tenantId: "tenant-main",
          domain: "shop.example.com",
          kind: "productPage",
          priority: 20,
        }),
        makeTarget({
          id: "target-dup-001",
          tenantId: "tenant-alt",
          domain: "blog.example.com",
          kind: "productListing",
          priority: 10,
        }),
      ];

      const duplicateSdkError = yield* Effect.flip(
        runTargetImportOperation({ targets: duplicateTargets }),
      );
      const duplicateCli = yield* Effect.promise(() =>
        executeCli(["target", "import", "--input", JSON.stringify({ targets: duplicateTargets })]),
      );
      const invalidFilterSdkError = yield* Effect.flip(
        runTargetListOperation({
          targets: [duplicateTargets[0]],
          filters: {
            kind: "searchPage",
          },
        }),
      );
      const invalidFilterCli = yield* Effect.promise(() =>
        executeCli([
          "target",
          "list",
          "--input",
          JSON.stringify({
            targets: [duplicateTargets[0]],
            filters: {
              kind: "searchPage",
            },
          }),
        ]),
      );

      expect(duplicateSdkError).toBeInstanceOf(InvalidInputError);
      expect(duplicateSdkError.message).toContain("Invalid target import payload.");
      expect(duplicateCli.exitCode).toBe(2);
      expect(JSON.parse(duplicateCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });

      expect(invalidFilterSdkError).toBeInstanceOf(InvalidInputError);
      expect(invalidFilterSdkError.message).toContain("Invalid target list payload.");
      expect(invalidFilterCli.exitCode).toBe(2);
      expect(JSON.parse(invalidFilterCli.output)).toMatchObject({
        ok: false,
        code: "InvalidInputError",
      });
    }),
  );
});
