import { load } from "cheerio";
import { isTag, type Element } from "domhandler";
import { Effect, Schema } from "effect";
import { CanonicalIdentifierSchema, CanonicalKeySchema } from "./schema-primitives.ts";
import { ParserFailure } from "./tagged-errors.ts";

const NonEmptyHtmlSchema = Schema.Trim.check(Schema.isNonEmpty());
const HtmlAttributesSchema = Schema.Record(Schema.String, Schema.String);

export const DeterministicParserInputSchema = Schema.Struct({
  documentId: CanonicalIdentifierSchema,
  html: NonEmptyHtmlSchema,
});

export class ParsedHtmlNode extends Schema.Class<ParsedHtmlNode>("ParsedHtmlNode")({
  path: CanonicalKeySchema,
  tagName: Schema.String,
  attributes: HtmlAttributesSchema,
  textContent: Schema.String,
  childPaths: Schema.Array(CanonicalKeySchema),
}) {}

const ParsedHtmlNodesSchema = Schema.Array(ParsedHtmlNode).pipe(
  Schema.refine(
    (nodes): nodes is ReadonlyArray<ParsedHtmlNode> =>
      nodes.length > 0 && new Set(nodes.map(({ path }) => path)).size === nodes.length,
    {
      message: "Expected deterministic parser output with at least one node and unique paths.",
    },
  ),
);

export class ParsedHtmlDocument extends Schema.Class<ParsedHtmlDocument>("ParsedHtmlDocument")({
  documentId: CanonicalIdentifierSchema,
  normalizedHtml: NonEmptyHtmlSchema,
  rootPath: CanonicalKeySchema,
  nodes: ParsedHtmlNodesSchema,
}) {}

export const ParsedHtmlNodeSchema = ParsedHtmlNode;
export const ParsedHtmlDocumentSchema = ParsedHtmlDocument;

const ROOT_PATH = "document";

function normalizeTextContent(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function readCauseMessage(cause: unknown, fallback: string) {
  if ((typeof cause === "object" && cause !== null) || typeof cause === "function") {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message.trim() !== "") {
      return message;
    }
  }

  return fallback;
}

function toSortedAttributes(
  attributes: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function buildParsedNodes(
  $: ReturnType<typeof load>,
  element: Element,
  path: string,
): ReadonlyArray<ParsedHtmlNode> {
  const childElements = $(element).children().toArray().filter(isTag);
  const childPaths = childElements.map((_, index) => `${path}/${index}`);
  const node = Schema.decodeUnknownSync(ParsedHtmlNodeSchema)({
    path,
    tagName: element.tagName,
    attributes: toSortedAttributes(element.attribs),
    textContent: normalizeTextContent($(element).text()),
    childPaths,
  });

  return [
    node,
    ...childElements.flatMap((child, index) => buildParsedNodes($, child, childPaths[index]!)),
  ];
}

export function parseDeterministicHtml(input: unknown) {
  return Effect.try({
    try: () => {
      const decoded = Schema.decodeUnknownSync(DeterministicParserInputSchema)(input);
      const $ = load(decoded.html);
      const rootChildren = $.root().children().toArray().filter(isTag);
      const rootChildPaths = rootChildren.map((_, index) => `${ROOT_PATH}/${index}`);
      const rootNode = Schema.decodeUnknownSync(ParsedHtmlNodeSchema)({
        path: ROOT_PATH,
        tagName: "document",
        attributes: {},
        textContent: normalizeTextContent($.root().text()),
        childPaths: rootChildPaths,
      });

      return Schema.decodeUnknownSync(ParsedHtmlDocumentSchema)({
        documentId: decoded.documentId,
        normalizedHtml: decoded.html,
        rootPath: ROOT_PATH,
        nodes: [
          rootNode,
          ...rootChildren.flatMap((child, index) =>
            buildParsedNodes($, child, rootChildPaths[index]!),
          ),
        ],
      });
    },
    catch: (cause) =>
      new ParserFailure({
        message: readCauseMessage(cause, "Failed to parse HTML document deterministically."),
      }),
  });
}
