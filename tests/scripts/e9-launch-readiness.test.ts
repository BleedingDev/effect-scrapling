import { describe, expect, it } from "@effect-native/bun-test";
import { Schema } from "effect";
import {
  E9LaunchReadinessArtifactSchema,
  runE9LaunchReadiness,
} from "../../src/e9-launch-readiness.ts";
import { parseOptions } from "../../scripts/benchmarks/e9-launch-readiness.ts";

describe("e9 launch readiness replay", () => {
  it("parses only the supported artifact option", () => {
    expect(parseOptions([])).toEqual({
      artifactPath: undefined,
    });
    expect(parseOptions(["--artifact", "tmp/e9-launch-readiness.json"])).toEqual({
      artifactPath: "tmp/e9-launch-readiness.json",
    });
    expect(() => parseOptions(["--artifact"])).toThrow("Missing value for argument: --artifact");
    expect(() => parseOptions(["--bogus"])).toThrow("Unknown argument: --bogus");
  });

  it("passes when all required E9 artifacts and docs are present and healthy", async () => {
    const artifact = await runE9LaunchReadiness({
      readJson: async (path) => {
        if (path.endsWith("e9-reference-pack-validation-artifact.json")) {
          return JSON.parse(
            await Bun.file("docs/artifacts/e9-reference-pack-validation-artifact.json").text(),
          );
        }

        if (path.endsWith("e9-scrapling-parity-artifact.json")) {
          return {
            benchmark: "e9-scrapling-parity",
            comparisonId: "comparison-e9",
            generatedAt: "2026-03-08T22:15:00.000Z",
            caseCount: 10,
            measurementMode: "fixture-corpus-postcapture",
            scraplingRuntime: {
              scraplingVersion: "0.4.1",
              parserAvailable: true,
              fetcherAvailable: false,
              fetcherDiagnostic: "Fetcher runtime unavailable in test double.",
            },
            summary: {
              ours: {
                measurementMode: "fixture-corpus-postcapture",
                fetchSuccessRate: 1,
                extractionCompleteness: 1,
                bypassSuccessRate: 1,
              },
              scrapling: {
                measurementMode: "fixture-corpus-postcapture",
                fetchSuccessRate: 1,
                extractionCompleteness: 1,
                bypassSuccessRate: 1,
              },
              equalOrBetter: {
                fetchSuccess: true,
                extractionCompleteness: true,
                bypassSuccess: true,
              },
            },
            cases: [],
            status: "pass",
          };
        }

        return {
          benchmark: "e9-high-friction-canary",
          suiteId: "suite-e9-high-friction-canary",
          generatedAt: "2026-03-08T22:25:00.000Z",
          status: "pass",
          summary: {
            scenarioCount: 10,
            browserEscalationRate: 1,
            bypassSuccessRate: 1,
            policyViolationCount: 0,
            promotionVerdict: "promote",
          },
          results: [
            {
              caseId: "case-e9-alza-tesla-s300w",
              retailer: "alza",
              provider: "browser",
              action: "active",
              status: "pass",
              requiresBypass: true,
              bypassQualified: true,
              policyCompliant: true,
            },
          ],
          liveCanary: {
            benchmark: "e7-live-canary",
            suiteId: "suite-e9-high-friction-canary",
            generatedAt: "2026-03-08T22:25:00.000Z",
            status: "pass",
            summary: {
              scenarioCount: 10,
              passedScenarioCount: 10,
              failedScenarioIds: [],
              verdict: "promote",
            },
            results: [
              {
                scenarioId: "scenario-case-e9-alza-tesla-s300w",
                authorizationId: "auth-case-e9-alza-tesla-s300w",
                provider: "browser",
                action: "active",
                failedStages: [],
                status: "pass",
                plannerRationale: [
                  {
                    key: "capture-path",
                    message: "Capture step selected browser provider.",
                  },
                ],
              },
            ],
          },
        };
      },
      pathExists: async () => true,
    });
    const decoded: Schema.Schema.Type<typeof E9LaunchReadinessArtifactSchema> =
      Schema.decodeUnknownSync(E9LaunchReadinessArtifactSchema)(artifact);

    expect(decoded.status).toBe("pass");
    expect(decoded.missingItems).toEqual([]);
    expect(decoded.sections.referencePacks).toBe(true);
    expect(decoded.sections.parity).toBe(true);
    expect(decoded.sections.canary).toBe(true);
  });

  it("fails when a required launch doc is missing", async () => {
    const artifact = await runE9LaunchReadiness({
      pathExists: async (path) => path !== "docs/runbooks/e9-launch-migration.md",
      readJson: async (path) => {
        if (path.endsWith("e9-reference-pack-validation-artifact.json")) {
          return JSON.parse(
            await Bun.file("docs/artifacts/e9-reference-pack-validation-artifact.json").text(),
          );
        }
        if (path.endsWith("e9-scrapling-parity-artifact.json")) {
          return {
            benchmark: "e9-scrapling-parity",
            comparisonId: "comparison-e9",
            generatedAt: "2026-03-08T22:15:00.000Z",
            caseCount: 10,
            measurementMode: "fixture-corpus-postcapture",
            scraplingRuntime: {
              scraplingVersion: "0.4.1",
              parserAvailable: true,
              fetcherAvailable: false,
              fetcherDiagnostic: "Fetcher runtime unavailable in test double.",
            },
            summary: {
              ours: {
                measurementMode: "fixture-corpus-postcapture",
                fetchSuccessRate: 1,
                extractionCompleteness: 1,
                bypassSuccessRate: 1,
              },
              scrapling: {
                measurementMode: "fixture-corpus-postcapture",
                fetchSuccessRate: 1,
                extractionCompleteness: 1,
                bypassSuccessRate: 1,
              },
              equalOrBetter: {
                fetchSuccess: true,
                extractionCompleteness: true,
                bypassSuccess: true,
              },
            },
            cases: [],
            status: "pass",
          };
        }

        return {
          benchmark: "e9-high-friction-canary",
          suiteId: "suite-e9-high-friction-canary",
          generatedAt: "2026-03-08T22:25:00.000Z",
          status: "pass",
          summary: {
            scenarioCount: 10,
            browserEscalationRate: 1,
            bypassSuccessRate: 1,
            policyViolationCount: 0,
            promotionVerdict: "promote",
          },
          results: [
            {
              caseId: "case-e9-alza-tesla-s300w",
              retailer: "alza",
              provider: "browser",
              action: "active",
              status: "pass",
              requiresBypass: true,
              bypassQualified: true,
              policyCompliant: true,
            },
          ],
          liveCanary: {
            benchmark: "e7-live-canary",
            suiteId: "suite-e9-high-friction-canary",
            generatedAt: "2026-03-08T22:25:00.000Z",
            status: "pass",
            summary: {
              scenarioCount: 10,
              passedScenarioCount: 10,
              failedScenarioIds: [],
              verdict: "promote",
            },
            results: [
              {
                scenarioId: "scenario-case-e9-alza-tesla-s300w",
                authorizationId: "auth-case-e9-alza-tesla-s300w",
                provider: "browser",
                action: "active",
                failedStages: [],
                status: "pass",
                plannerRationale: [
                  {
                    key: "capture-path",
                    message: "Capture step selected browser provider.",
                  },
                ],
              },
            ],
          },
        };
      },
    });

    expect(artifact.status).toBe("fail");
    expect(artifact.missingItems).toContain("docs/runbooks/e9-launch-migration.md");
  });
});
