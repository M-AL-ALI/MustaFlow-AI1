import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Drizzle treats backslashes in schema globs as escapes on Windows. Keep the
  // absolute path, but normalize it before handing it to the CLI.
  schema: path.join(__dirname, "./src/schema/index.ts").replaceAll("\\", "/"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
