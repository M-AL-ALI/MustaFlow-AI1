export const SECRET_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ImportedSecret {
  name: string;
  value: string;
}

export class SecretImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretImportError";
  }
}

function validatePair(name: string, value: string, location: string): ImportedSecret {
  if (!SECRET_ENV_NAME_PATTERN.test(name)) {
    throw new SecretImportError(`${location}: “${name}” is not a valid environment-variable name.`);
  }
  if (value.length === 0) {
    throw new SecretImportError(`${location}: ${name} has no value.`);
  }
  return { name, value };
}

function dedupeLastValue(pairs: ImportedSecret[]): ImportedSecret[] {
  const values = new Map<string, string>();
  for (const pair of pairs) values.set(pair.name, pair.value);
  return Array.from(values, ([name, value]) => ({ name, value }));
}

/** Parse a pasted .env document without executing interpolation or shell syntax. */
export function parseDotEnvSecrets(text: string): ImportedSecret[] {
  const pairs: ImportedSecret[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();

    const equalsAt = line.indexOf("=");
    if (equalsAt < 1) {
      throw new SecretImportError(`Line ${index + 1}: expected NAME=value.`);
    }

    const name = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    pairs.push(validatePair(name, value, `Line ${index + 1}`));
  }

  if (pairs.length === 0) throw new SecretImportError("No valid secrets found in the input.");
  return dedupeLastValue(pairs);
}

export function parseJsonSecrets(text: string): ImportedSecret[] {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretImportError("JSON input must be an object of secret names and values.");
  }

  const pairs = Object.entries(parsed).map(([name, value]) => {
    if (typeof value !== "string") {
      throw new SecretImportError(`JSON key ${name} must have a string value.`);
    }
    return validatePair(name, value, `JSON key ${name}`);
  });
  if (pairs.length === 0) throw new SecretImportError("No valid secrets found in the input.");
  return dedupeLastValue(pairs);
}
