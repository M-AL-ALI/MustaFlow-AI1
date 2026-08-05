const MAX_ARG_COUNT = 256;
const MAX_COMMAND_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

export function escapePosixShellArgument(argument: string): string {
  if (argument.includes("\0")) throw new Error("Shell arguments cannot contain NUL bytes");
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

export function argvToCommandString(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error("At least one argv entry is required");
  if (argv.length > MAX_ARG_COUNT) throw new Error(`argv cannot exceed ${MAX_ARG_COUNT} entries`);

  const encoded = argv.map(escapePosixShellArgument).join(" ");
  if (textEncoder.encode(encoded).byteLength > MAX_COMMAND_BYTES) {
    throw new Error(`Encoded command cannot exceed ${MAX_COMMAND_BYTES} bytes`);
  }
  return encoded;
}
