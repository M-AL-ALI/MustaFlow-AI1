import { verifyProductionRelease } from "./production-release-verifier";
import { verifyCloudflareRuntimeRelease } from "./cloudflare-runtime-release-verifier";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

const baseUrl = argument("base-url");
const expectedTree = argument("expected-tree");
const timeoutText = argument("timeout-ms");
const runtimeConfig = argument("runtime-config");

if (!baseUrl || !expectedTree) {
  process.stderr.write(
    `${JSON.stringify({ code: "release_verification_input_invalid", required: ["base-url", "expected-tree"] })}\n`,
  );
  process.exitCode = 2;
} else {
  try {
    const receipt = await verifyProductionRelease({
      baseUrl,
      expectedTree,
      timeoutMs: timeoutText == null ? undefined : Number(timeoutText),
    });
    const cloudflareRuntime = await verifyCloudflareRuntimeRelease({
      expectedCommit: receipt.version.commit,
      expectedTree: receipt.version.tree,
      configPath: runtimeConfig,
      timeoutMs: timeoutText == null ? undefined : Number(timeoutText),
    });
    process.stdout.write(`${JSON.stringify({ ...receipt, cloudflareRuntime }, null, 2)}\n`);
  } catch (error) {
    const candidate = error as {
      code?: unknown;
      command?: unknown;
      endpoint?: unknown;
      status?: unknown;
    };
    process.stderr.write(
      `${JSON.stringify({
        code:
          typeof candidate.code === "string"
            ? candidate.code
            : "release_verification_unexpected_failure",
        endpoint: typeof candidate.endpoint === "string" ? candidate.endpoint : null,
        command: typeof candidate.command === "string" ? candidate.command : null,
        status: typeof candidate.status === "number" ? candidate.status : null,
      })}\n`,
    );
    process.exitCode = 1;
  }
}
