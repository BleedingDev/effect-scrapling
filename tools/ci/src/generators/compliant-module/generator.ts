import {
  formatFiles,
  joinPathFragments,
  names,
  readProjectConfiguration,
  type Tree,
} from "@nx/devkit";
import { posix } from "node:path";

type CompliantModuleGeneratorOptions = {
  readonly name: string;
  readonly project: string;
  readonly directory?: string;
};

type NormalizedOptions = {
  readonly moduleName: string;
  readonly moduleClassName: string;
  readonly moduleTagClassName: string;
  readonly moduleLayerName: string;
  readonly moduleEffectFunctionName: string;
  readonly moduleRequestSchemaName: string;
  readonly moduleResultSchemaName: string;
  readonly moduleDecodeErrorClassName: string;
  readonly moduleExecutionErrorClassName: string;
  readonly moduleDirectory: string;
  readonly testDirectory: string;
  readonly schemaFilePath: string;
  readonly errorsFilePath: string;
  readonly tagFilePath: string;
  readonly layerFilePath: string;
  readonly effectFilePath: string;
  readonly testFilePath: string;
  readonly effectImportPathFromTest: string;
  readonly layerImportPathFromTest: string;
  readonly moduleTagIdentifier: string;
};

const MODULE_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/u;
const PROJECT_SEGMENT_PATTERN = /^[a-z0-9-]+$/u;

function normalizeSegment(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`The "${fieldName}" option must not be empty.`);
  }

  const normalized = trimmed
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[_\s]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();

  if (!MODULE_SEGMENT_PATTERN.test(normalized)) {
    throw new Error(
      `The "${fieldName}" option must normalize to kebab-case with a leading letter (received "${value}").`,
    );
  }

  return normalized;
}

function normalizeDirectory(directory: string | undefined): readonly string[] {
  if (directory === undefined) {
    return [];
  }

  const trimmed = directory.trim();
  if (trimmed.length === 0) {
    return [];
  }

  return trimmed
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => normalizeSegment(segment, "directory"));
}

function normalizeProjectForPath(project: string): string {
  const trimmed = project.trim();
  if (trimmed.length === 0) {
    throw new Error('The "project" option must not be empty.');
  }

  const normalized = trimmed
    .replace(/[^A-Za-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();

  if (!PROJECT_SEGMENT_PATTERN.test(normalized)) {
    throw new Error(
      `The "project" option must contain at least one alphanumeric token (received "${project}").`,
    );
  }

  return normalized;
}

function toImportPath(fromDirectory: string, targetFilePathWithoutExtension: string): string {
  const relativePath = posix.relative(fromDirectory, targetFilePathWithoutExtension);
  if (relativePath.length === 0) {
    return "./";
  }

  if (relativePath.startsWith(".")) {
    return relativePath;
  }

  return `./${relativePath}`;
}

function buildSchemaSource(options: NormalizedOptions): string {
  return `import { Schema } from "effect";

const NonEmptyTrimmedString = Schema.Trim.check(Schema.isNonEmpty());

export const ${options.moduleRequestSchemaName} = Schema.Struct({
  input: NonEmptyTrimmedString,
});

export type ${options.moduleRequestSchemaName.replace(/Schema$/u, "")} = Schema.Schema.Type<typeof ${options.moduleRequestSchemaName}>;

export const ${options.moduleResultSchemaName} = Schema.Struct({
  output: Schema.String,
});

export type ${options.moduleResultSchemaName.replace(/Schema$/u, "")} = Schema.Schema.Type<typeof ${options.moduleResultSchemaName}>;
`;
}

function buildErrorsSource(options: NormalizedOptions): string {
  return `import { Data } from "effect";

export class ${options.moduleDecodeErrorClassName} extends Data.TaggedError("${options.moduleDecodeErrorClassName}")<{
  readonly message: string;
  readonly details?: string;
}> {}

export class ${options.moduleExecutionErrorClassName} extends Data.TaggedError("${options.moduleExecutionErrorClassName}")<{
  readonly message: string;
  readonly details?: string;
}> {}
`;
}

function buildTagSource(options: NormalizedOptions): string {
  const requestTypeName = options.moduleRequestSchemaName.replace(/Schema$/u, "");
  const resultTypeName = options.moduleResultSchemaName.replace(/Schema$/u, "");

  return `import { Effect, ServiceMap } from "effect";
import type { ${options.moduleExecutionErrorClassName} } from "./${options.moduleName}.errors";
import type { ${requestTypeName}, ${resultTypeName} } from "./${options.moduleName}.schema";

export type ${options.moduleTagClassName}Shape = {
  readonly run: (
    request: ${requestTypeName},
  ) => Effect.Effect<${resultTypeName}, ${options.moduleExecutionErrorClassName}>;
};

export class ${options.moduleTagClassName} extends ServiceMap.Service<${options.moduleTagClassName}, ${options.moduleTagClassName}Shape>()(
  "${options.moduleTagIdentifier}",
) {}
`;
}

function buildLayerSource(options: NormalizedOptions): string {
  const requestTypeName = options.moduleRequestSchemaName.replace(/Schema$/u, "");
  const resultTypeName = options.moduleResultSchemaName.replace(/Schema$/u, "");

  return `import { Effect, Layer } from "effect";
import { ${options.moduleExecutionErrorClassName} } from "./${options.moduleName}.errors";
import { ${options.moduleTagClassName} } from "./${options.moduleName}.tag";
import type { ${requestTypeName}, ${resultTypeName} } from "./${options.moduleName}.schema";

function run(
  request: ${requestTypeName},
): Effect.Effect<${resultTypeName}, ${options.moduleExecutionErrorClassName}> {
  return Effect.gen(function* () {
    const normalizedInput = request.input.trim();

    if (normalizedInput.toLowerCase() === "fail") {
      return yield* Effect.fail(
        new ${options.moduleExecutionErrorClassName}({
          message:
            "The generated scaffold fails for input \\"fail\\" to provide a deterministic error path.",
        }),
      );
    }

    return {
      output: normalizedInput.toUpperCase(),
    };
  });
}

export const ${options.moduleLayerName} = Layer.succeed(${options.moduleTagClassName})({
  run,
});
`;
}

function buildEffectSource(options: NormalizedOptions): string {
  const requestTypeName = options.moduleRequestSchemaName.replace(/Schema$/u, "");
  const resultTypeName = options.moduleResultSchemaName.replace(/Schema$/u, "");

  return `import { Effect, Schema } from "effect";
import { ${options.moduleDecodeErrorClassName}, type ${options.moduleExecutionErrorClassName} } from "./${options.moduleName}.errors";
import { ${options.moduleRequestSchemaName}, type ${requestTypeName}, type ${resultTypeName} } from "./${options.moduleName}.schema";
import { ${options.moduleTagClassName} } from "./${options.moduleName}.tag";

export function ${options.moduleEffectFunctionName}(
  payload: unknown,
): Effect.Effect<${resultTypeName}, ${options.moduleDecodeErrorClassName} | ${options.moduleExecutionErrorClassName}, ${options.moduleTagClassName}> {
  return Effect.gen(function* () {
    const request: ${requestTypeName} = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(${options.moduleRequestSchemaName})(payload),
      catch: (cause) =>
        new ${options.moduleDecodeErrorClassName}({
          message: "Unable to decode module request payload.",
          details: cause instanceof Error ? \`\${cause.name}: \${cause.message}\` : String(cause),
        }),
    });

    const service = yield* ${options.moduleTagClassName};
    return yield* service.run(request);
  });
}
`;
}

function buildTestSource(options: NormalizedOptions): string {
  const resultTypeName = options.moduleResultSchemaName.replace(/Schema$/u, "");

  return `import { Effect } from "effect";
import { describe, expect, it } from "@effect-native/bun-test";
import { ${options.moduleEffectFunctionName} } from "${options.effectImportPathFromTest}";
import { ${options.moduleLayerName} } from "${options.layerImportPathFromTest}";

describe("${options.moduleEffectFunctionName} scaffold", () => {
  it("returns uppercase output for valid payload", async () => {
    const result = await Effect.runPromise(
      ${options.moduleEffectFunctionName}({ input: "hello world" }).pipe(Effect.provide(${options.moduleLayerName})),
    );

    expect(result).toEqual<${resultTypeName}>({
      output: "HELLO WORLD",
    });
  });

  it("fails decoding invalid payloads", async () => {
    const exit = await Effect.runPromiseExit(${options.moduleEffectFunctionName}({}));
    expect(exit._tag).toBe("Failure");
  });

  it("fails deterministically on runtime sentinel payload", async () => {
    const exit = await Effect.runPromiseExit(
      ${options.moduleEffectFunctionName}({ input: "fail" }).pipe(Effect.provide(${options.moduleLayerName})),
    );
    expect(exit._tag).toBe("Failure");
  });
});
`;
}

function normalizeOptions(tree: Tree, options: CompliantModuleGeneratorOptions): NormalizedOptions {
  if (options.project.trim().length === 0) {
    throw new Error('The "project" option is required.');
  }

  const projectConfiguration = readProjectConfiguration(tree, options.project);
  const sourceRoot =
    projectConfiguration.sourceRoot ?? joinPathFragments(projectConfiguration.root, "src");

  const moduleName = normalizeSegment(options.name, "name");
  const directorySegments = normalizeDirectory(options.directory);
  const testProjectSegment = normalizeProjectForPath(options.project);
  const moduleNames = names(moduleName);
  const moduleClassName = moduleNames.className;
  const moduleTagClassName = `${moduleClassName}Tag`;
  const moduleLayerName = `${moduleClassName}Layer`;
  const moduleEffectFunctionName = `run${moduleClassName}`;
  const moduleRequestSchemaName = `${moduleClassName}RequestSchema`;
  const moduleResultSchemaName = `${moduleClassName}ResultSchema`;
  const moduleDecodeErrorClassName = `${moduleClassName}DecodeError`;
  const moduleExecutionErrorClassName = `${moduleClassName}ExecutionError`;

  const moduleDirectory = joinPathFragments(sourceRoot, ...directorySegments, moduleName);
  const testDirectory = joinPathFragments(
    "tests",
    "generated-modules",
    testProjectSegment,
    ...directorySegments,
  );
  const effectImportPathFromTest = toImportPath(
    testDirectory,
    joinPathFragments(moduleDirectory, `${moduleName}.effect`),
  );
  const layerImportPathFromTest = toImportPath(
    testDirectory,
    joinPathFragments(moduleDirectory, `${moduleName}.layer`),
  );

  return {
    moduleName,
    moduleClassName,
    moduleTagClassName,
    moduleLayerName,
    moduleEffectFunctionName,
    moduleRequestSchemaName,
    moduleResultSchemaName,
    moduleDecodeErrorClassName,
    moduleExecutionErrorClassName,
    moduleDirectory,
    testDirectory,
    schemaFilePath: joinPathFragments(moduleDirectory, `${moduleName}.schema.ts`),
    errorsFilePath: joinPathFragments(moduleDirectory, `${moduleName}.errors.ts`),
    tagFilePath: joinPathFragments(moduleDirectory, `${moduleName}.tag.ts`),
    layerFilePath: joinPathFragments(moduleDirectory, `${moduleName}.layer.ts`),
    effectFilePath: joinPathFragments(moduleDirectory, `${moduleName}.effect.ts`),
    testFilePath: joinPathFragments(testDirectory, `${moduleName}.test.ts`),
    effectImportPathFromTest,
    layerImportPathFromTest,
    moduleTagIdentifier: `@effect-scrapling/${moduleTagClassName}`,
  };
}

function scaffoldModule(tree: Tree, options: NormalizedOptions): void {
  tree.write(options.schemaFilePath, buildSchemaSource(options));
  tree.write(options.errorsFilePath, buildErrorsSource(options));
  tree.write(options.tagFilePath, buildTagSource(options));
  tree.write(options.layerFilePath, buildLayerSource(options));
  tree.write(options.effectFilePath, buildEffectSource(options));
  tree.write(options.testFilePath, buildTestSource(options));
}

export default async function compliantModuleGenerator(
  tree: Tree,
  options: CompliantModuleGeneratorOptions,
): Promise<void> {
  const normalizedOptions = normalizeOptions(tree, options);
  scaffoldModule(tree, normalizedOptions);
  await formatFiles(tree);
}
