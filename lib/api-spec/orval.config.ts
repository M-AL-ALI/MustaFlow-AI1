import { defineConfig, InputTransformerFn } from "orval";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "path";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");
const apiZodSrc = path.resolve(root, "lib", "api-zod", "src");

// Our exports make assumptions about the title of the API being "Api" (i.e. generated output is `api.ts`).
const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";

  return config;
};

const normalizeGeneratedEof = (filePaths: string[]) => {
  const normalizePath = (filePath: string): void => {
    if (statSync(filePath).isDirectory()) {
      for (const child of readdirSync(filePath)) normalizePath(path.join(filePath, child));
      return;
    }
    const source = readFileSync(filePath, "utf8");
    const normalized = source.replace(/(?:\r?\n)+$/u, "\n");
    if (normalized !== source) writeFileSync(filePath, normalized, "utf8");
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
