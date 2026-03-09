import { describe, expect, it, setDefaultTimeout } from "@effect-native/bun-test";
import { Schema } from "effect";
import { createDefaultE9RetailerCorpus } from "../../src/e9-fixture-corpus.ts";
import {
  E9ScraplingParityArtifactSchema,
  runE9ScraplingParity,
} from "../../src/e9-scrapling-parity.ts";
import {
  parseOptions,
  runDefaultE9ScraplingParity,
} from "../../scripts/benchmarks/e9-scrapling-parity.ts";

setDefaultTimeout(20_000);

describe("e9 scrapling parity benchmark", () => {
  it("parses only the supported artifact option", () => {
    expect(parseOptions([])).toEqual({
      artifactPath: undefined,
    });
    expect(parseOptions(["--artifact", "tmp/e9-scrapling-parity.json"])).toEqual({
      artifactPath: "tmp/e9-scrapling-parity.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown argument: --bogus");
  });

  it("produces a passing 10-product parity artifact when Scrapling returns the expected field values", async () => {
    const corpus = await createDefaultE9RetailerCorpus();
    const artifact = await runE9ScraplingParity({
      selectWithScrapling: async () => ({
        runtime: {
          scraplingVersion: "0.4.1",
          parserAvailable: true,
          fetcherAvailable: false,
          fetcherDiagnostic: "Fetcher runtime unavailable in test double.",
        },
        results: corpus.map((caseInput) => ({
          caseId: caseInput.caseId,
          fields: [
            {
              field: "title",
              matchedPath: caseInput.referencePack.recipe.fields[0]?.selectors[0]?.path,
              rawValue: caseInput.expectedRawFields.title,
            },
            {
              field: "price",
              matchedPath: caseInput.referencePack.recipe.fields[1]?.selectors[0]?.path,
              rawValue: caseInput.expectedRawFields.price,
            },
            {
              field: "availability",
              matchedPath: caseInput.referencePack.recipe.fields[2]?.selectors[0]?.path,
              rawValue: caseInput.expectedRawFields.availability,
            },
            {
              field: "productIdentifier",
              matchedPath: caseInput.referencePack.recipe.fields[3]?.selectors[0]?.path,
              rawValue: caseInput.expectedRawFields.productIdentifier,
            },
          ],
        })),
      }),
    });

    const decoded: Schema.Schema.Type<typeof E9ScraplingParityArtifactSchema> =
      Schema.decodeUnknownSync(E9ScraplingParityArtifactSchema)(artifact);
    expect(decoded.caseCount).toBe(10);
    expect(decoded.status).toBe("pass");
    expect(decoded.summary.equalOrBetter.extractionCompleteness).toBe(true);
    expect(decoded.summary.equalOrBetter.fetchSuccess).toBe(true);
    expect(decoded.summary.equalOrBetter.bypassSuccess).toBe(true);
  });

  it("fails when Scrapling misses a required field in the corpus comparison", async () => {
    const corpus = await createDefaultE9RetailerCorpus();
    const firstCase = corpus[0];
    if (firstCase === undefined) {
      throw new Error("Expected the first E9 corpus case.");
    }

    const artifact = await runE9ScraplingParity({
      selectWithScrapling: async () => ({
        runtime: {
          scraplingVersion: "0.4.1",
          parserAvailable: true,
          fetcherAvailable: false,
          fetcherDiagnostic: "Fetcher runtime unavailable in test double.",
        },
        results: corpus.map((caseInput) => ({
          caseId: caseInput.caseId,
          fields:
            caseInput.caseId === firstCase.caseId
              ? [
                  {
                    field: "title",
                    matchedPath: caseInput.referencePack.recipe.fields[0]?.selectors[0]?.path,
                    rawValue: caseInput.expectedRawFields.title,
                  },
                ]
              : [
                  {
                    field: "title",
                    matchedPath: caseInput.referencePack.recipe.fields[0]?.selectors[0]?.path,
                    rawValue: caseInput.expectedRawFields.title,
                  },
                  {
                    field: "price",
                    matchedPath: caseInput.referencePack.recipe.fields[1]?.selectors[0]?.path,
                    rawValue: caseInput.expectedRawFields.price,
                  },
                  {
                    field: "availability",
                    matchedPath: caseInput.referencePack.recipe.fields[2]?.selectors[0]?.path,
                    rawValue: caseInput.expectedRawFields.availability,
                  },
                  {
                    field: "productIdentifier",
                    matchedPath: caseInput.referencePack.recipe.fields[3]?.selectors[0]?.path,
                    rawValue: caseInput.expectedRawFields.productIdentifier,
                  },
                ],
        })),
      }),
    });

    expect(artifact.status).toBe("fail");
    expect(
      artifact.cases.find(({ caseId }) => caseId === firstCase.caseId)?.scraplingCompleteness,
    ).toBeLessThan(1);
  });

  it("bootstraps the real Scrapling selector runtime through the benchmark harness", async () => {
    const artifact = await runDefaultE9ScraplingParity({});

    expect(artifact.status).toBe("pass");
    expect(artifact.scraplingRuntime.scraplingVersion).toBe("0.4.1");
    expect(artifact.caseCount).toBe(10);
  });
});
