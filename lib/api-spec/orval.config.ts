import { defineConfig, InputTransformerFn } from "orval";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");
const dormantExports = JSON.parse(
  readFileSync(
    path.resolve(root, "artifacts", "api-server", "src", "lib", "dormant-exports.json"),
    "utf8",
  ),
) as Array<{ path: string; symbol: string }>;
const generatedDormantExports = Map.groupBy(
  dormantExports.filter((entry) => entry.path.includes("/generated/")),
  (entry) => entry.path,
);

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

const normalizeGeneratedEof = (filePaths: string[]) => {
  const normalizePath = (filePath: string): void => {
    const absolutePath = path.resolve(filePath);
    if (statSync(absolutePath).isDirectory()) {
      for (const child of readdirSync(absolutePath)) normalizePath(path.join(absolutePath, child));
      return;
    }
    const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, "/");
    const source = readFileSync(absolutePath, "utf8");
    let generated = source;
    for (const entry of generatedDormantExports.get(relativePath) ?? []) {
      const definition = generated.indexOf(entry.symbol);
      if (definition < 0) throw new Error(`Generated dormant export missing: ${entry.symbol}`);
      if (generated.slice(Math.max(0, definition - 600), definition).includes("@dormantExport")) {
        continue;
      }
      const lineStart = generated.lastIndexOf("\n", definition) + 1;
      generated = `${generated.slice(0, lineStart)}/** @dormantExport */\n${generated.slice(lineStart)}`;
    }
    generated = generated.replace(/(?:\r?\n)+$/u, "\n");
    if (generated !== source) writeFileSync(absolutePath, generated, "utf8");
  };
  for (const filePath of filePaths) normalizePath(filePath);
};

export default defineConfig({
  "api-client-react": {
    hooks: {
      afterAllFilesWrite: normalizeGeneratedEof,
    },
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiClientReactSrc,
      target: "generated",
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: false,
      prettier: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          path: path.resolve(apiClientReactSrc, "custom-fetch.ts"),
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    hooks: {
      afterAllFilesWrite: normalizeGeneratedEof,
    },
    input: {
      target: "./openapi.yaml",
      override: {
        transformer: titleTransformer,
      },
    },
    output: {
      workspace: apiZodSrc,
      client: "zod",
      target: "generated",
      schemas: { path: "generated/types", type: "typescript" },
      mode: "split",
      clean: false,
      prettier: true,
      override: {
        zod: {
          coerce: {
            query: ["boolean", "number", "string"],
            param: ["boolean", "number", "string"],
            body: ["bigint", "date"],
            response: ["bigint", "date"],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
