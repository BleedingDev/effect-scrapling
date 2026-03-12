import { describe, expect, it } from "@effect-native/bun-test";
import {
  classifyAccessWallKind,
  detectAccessWall,
  extractHtmlTitle,
  readAccessWallSignalsFromText,
  readAccessWallSignalsFromWarnings,
  toAccessWallWarnings,
} from "../../src/sdk/access-wall-detection.ts";

describe("sdk access wall detection", () => {
  it("detects challenge interstitials from redirect URLs and titles", () => {
    const analysis = detectAccessWall({
      requestedUrl: "https://store.example.test/products/sku-1",
      finalUrl: "https://edge.example.test/challenge?return_url=%2Fproducts%2Fsku-1",
      title: "Attention Required! | Security Check",
    });

    expect(analysis.likelyAccessWall).toBe(true);
    expect(analysis.signals).toContain("url-challenge");
    expect(analysis.signals).toContain("title-challenge");
  });

  it("detects consent interstitials from privacy copy without domain-specific rules", () => {
    const analysis = detectAccessWall({
      requestedUrl: "https://store.example.test/category/chairs",
      finalUrl: "https://privacy.example.test/consent/preferences?return_url=%2Fcategory%2Fchairs",
      title: "Your privacy choices",
      text: "Before you continue, manage your privacy choices and cookie preferences.",
    });

    expect(analysis.likelyAccessWall).toBe(true);
    expect(analysis.signals).toContain("url-consent");
    expect(analysis.signals).toContain("title-consent");
    expect(analysis.signals).toContain("text-consent");
  });

  it("detects trap interstitials from TSPD-style final urls", () => {
    const analysis = detectAccessWall({
      requestedUrl: "https://www.datart.cz/televize.html",
      finalUrl: "https://www.datart.cz/TSPD/?type=25&foo=bar",
      title: "",
      text: "",
    });

    expect(analysis.likelyAccessWall).toBe(true);
    expect(analysis.signals).toContain("url-trap");
    expect(classifyAccessWallKind(analysis.signals)).toBe("trap");
  });

  it("detects direct trap endpoints even without a redirect hop", () => {
    const analysis = detectAccessWall({
      requestedUrl: "https://www.datart.cz/TSPD/?type=25&foo=bar",
      finalUrl: "https://www.datart.cz/TSPD/?type=25&foo=bar",
      title: "",
      text: "",
    });

    expect(analysis.likelyAccessWall).toBe(true);
    expect(analysis.signals).toContain("url-trap");
    expect(classifyAccessWallKind(analysis.signals)).toBe("trap");
  });

  it("does not flag ordinary pages that merely mention cookies in a footer", () => {
    const analysis = detectAccessWall({
      requestedUrl: "https://store.example.test/products/sku-1",
      finalUrl: "https://store.example.test/products/sku-1",
      title: "Oak Dining Table",
      text: "<main>Oak Dining Table</main><footer>This site uses cookies for analytics.</footer>",
    });

    expect(analysis.likelyAccessWall).toBe(false);
  });

  it("does not flag ordinary pages that mention cookies and a privacy policy in body copy", () => {
    const analysis = detectAccessWall({
      requestedUrl: "https://store.example.test/products/sku-1",
      finalUrl: "https://store.example.test/products/sku-1",
      title: "Oak Dining Table",
      text: "<footer>We use cookies. Read our privacy policy for more details.</footer>",
    });

    expect(analysis.likelyAccessWall).toBe(false);
  });

  it("does not flag ordinary pages whose requested slug mentions privacy keywords", () => {
    const analysis = detectAccessWall({
      requestedUrl: "https://store.example.test/privacy-policy",
      finalUrl: "https://store.example.test/privacy-policy",
      title: "Privacy Policy",
      text: "<main>How we process data for customers.</main>",
    });

    expect(analysis.likelyAccessWall).toBe(false);
    expect(analysis.signals).not.toContain("url-consent");
  });

  it("does not flag ordinary content whose slug and title mention challenge keywords", () => {
    const analysis = detectAccessWall({
      requestedUrl: "https://store.example.test/products/challenge-cup",
      finalUrl: "https://store.example.test/products/challenge-cup",
      title: "Challenge Cup",
      text: "<main>Challenge Cup mug</main>",
    });

    expect(analysis.likelyAccessWall).toBe(false);
    expect(analysis.signals).not.toContain("url-challenge");
  });

  it("round-trips access wall warnings", () => {
    expect(
      readAccessWallSignalsFromWarnings(toAccessWallWarnings(["url-consent", "text-consent"])),
    ).toEqual(["text-consent", "url-consent"]);
  });

  it("extracts embedded access wall warnings from free-form error text", () => {
    expect(
      readAccessWallSignalsFromText(
        "BrowserError: HTTP 403 access-wall:status-403 access-wall:title-consent access-wall:text-consent",
      ),
    ).toEqual(["status-403", "text-consent", "title-consent"]);
  });

  it("classifies consent-heavy wall signals separately from challenge walls", () => {
    expect(
      classifyAccessWallKind(["text-cookies", "text-consent", "title-consent", "url-consent"]),
    ).toBe("consent");
    expect(classifyAccessWallKind(["status-403", "url-challenge"])).toBe("challenge");
    expect(classifyAccessWallKind(["status-403", "text-consent", "title-consent"])).toBe("consent");
    expect(classifyAccessWallKind(["text-cookies", "text-privacy"])).toBeUndefined();
    expect(classifyAccessWallKind(["url-challenge", "url-trap"])).toBe("challenge");
  });

  it("extracts normalized document titles", () => {
    expect(extractHtmlTitle("<title>  Your privacy choices  </title>")).toBe(
      "Your privacy choices",
    );
  });
});
