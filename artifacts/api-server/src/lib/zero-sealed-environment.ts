import { parseForESLint } from "@typescript-eslint/parser";

type Node = { type: string; [key: string]: unknown };

function node(value: unknown): Node | undefined {
  return typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
    ? (value as Node)
    : undefined;
}

function literal(value: unknown): string | undefined {
  const item = node(value);
  return item?.type === "Literal" && typeof item.value === "string" ? item.value : undefined;
}

function memberName(item: Node): string | undefined {
  const name = item.computed ? literal(item.property) : node(item.property)?.name;
  return typeof name === "string" ? name : undefined;
}

const ERASED_TYPE_EXPRESSIONS = new Set([
  "TSAsExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
]);

/** Erased type syntax preserves its expression, never the asserted type. */
function runtimeExpression(item: Node | undefined): Node | undefined {
  while (item && ERASED_TYPE_EXPRESSIONS.has(item.type)) item = node(item.expression);
  return item;
}

/** Only a literal PORT read is an application-owned environment capability. */
export function hasUnsupportedSealedEnvironmentAccess(file: {
  path: string;
  content: string;
}): boolean {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file.path)) return false;
  let parsed: ReturnType<typeof parseForESLint>;
  try {
    parsed = parseForESLint(file.content, {
      filePath: file.path,
      sourceType: "module",
      ecmaVersion: "latest",
      ecmaFeatures: { jsx: /\.[jt]sx$/u.test(file.path) },
      project: false,
    });
  } catch {
    return /\bprocess\b|import\s*\.\s*meta/u.test(file.content);
  }
  return inspectSealedEnvironmentSyntax(parsed).unsupportedAccess;
}

/** Share resolved bindings between source preparation and environment eligibility. */
export function inspectSealedEnvironmentSyntax(parsed: ReturnType<typeof parseForESLint>): {
  runtimePortRead: boolean;
  unsupportedAccess: boolean;
} {
  type Reference = (typeof parsed.scopeManager.scopes)[number]["references"][number];
  const references = new Map<object, Reference>();
  const parents = new Map<object, Node>();
  const indexParents = (value: unknown, parent?: Node): void => {
    const item = node(value);
    if (!item) return;
    if (parent) parents.set(item, parent);
    for (const key of parsed.visitorKeys[item.type] ?? []) {
      const child = item[key];
      if (Array.isArray(child)) child.forEach((entry) => indexParents(entry, item));
      else indexParents(child, item);
    }
  };
  indexParents(parsed.ast);
  type AliasWrite = { identifier: Node; value?: Node };
  const globalAliasWrites = new Map<object, AliasWrite[]>();
  for (const scope of parsed.scopeManager.scopes) {
    for (const reference of scope.references) {
      references.set(reference.identifier, reference);
      const value = node(reference.writeExpr);
      if (reference.resolved && reference.isWrite()) {
        const writes = globalAliasWrites.get(reference.resolved) ?? [];
        writes.push({ identifier: node(reference.identifier)!, value });
        globalAliasWrites.set(reference.resolved, writes);
      }
    }
  }
  const processBindings = new Set<object>();
  const environmentBindings = new Set<object>();
  for (const statement of parsed.ast.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type" ||
      !["process", "node:process"].includes(String(statement.source.value))
    )
      continue;
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportSpecifier" && binding.importKind === "type") continue;
      if (
        binding.type === "ImportDefaultSpecifier" ||
        binding.type === "ImportNamespaceSpecifier"
      ) {
        processBindings.add(binding.local);
      } else if (binding.type === "ImportSpecifier") {
        const imported = node(binding.imported);
        const name = imported?.name ?? imported?.value;
        if (name === "default") processBindings.add(binding.local);
        else if (name === "env") environmentBindings.add(binding.local);
      }
    }
  }
  const importedFrom = (item: Node, bindings: ReadonlySet<object>): boolean => {
    const reference = references.get(item);
    const definitions = reference?.resolved?.defs;
    return (
      reference?.isValueReference === true &&
      definitions?.length === 1 &&
      bindings.has(definitions[0].name)
    );
  };
  const globalIdentifier = (item: Node | undefined, name: string): boolean => {
    if (item?.type !== "Identifier" || item.name !== name) return false;
    const reference = references.get(item);
    return reference?.isValueReference === true && reference.resolved == null;
  };
  // A possible alias is enough to reject a credential read, but admission needs
  // definite provenance. Retire earlier writes only after a proven top-level
  // replacement. A single const initializer also survives a function boundary;
  // its value must still have definite provenance. Mutable or ambiguous writes
  // remain conservative.
  // This bounded syntax check is not a runtime credential-isolation boundary.
  type Certainty = "possible" | "definite";
  const programStatement = (value: Node): Node | undefined => {
    let current: Node | undefined = value;
    while (current) {
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
          "StaticBlock",
          "PropertyDefinition",
        ].includes(current.type)
      )
        return undefined;
      const parent = parents.get(current);
      if (parent?.type === "Program") return current;
      current = parent;
    }
    return undefined;
  };
  const statementOrder = new Map<object, number>(
    parsed.ast.body.map((statement, index) => [statement, index]),
  );
  const directReplacement = (write: AliasWrite): Node | undefined => {
    const parent = parents.get(write.identifier);
    if (
      parent?.type === "VariableDeclarator" &&
      parent.id === write.identifier &&
      parent.init === write.value
    ) {
      const declaration = parents.get(parent);
      if (
        declaration?.type === "VariableDeclaration" &&
        parents.get(declaration)?.type === "Program"
      )
        return declaration;
    }
    if (
      parent?.type === "AssignmentExpression" &&
      parent.operator === "=" &&
      parent.left === write.identifier &&
      parent.right === write.value
    ) {
      const statement = parents.get(parent);
      if (statement?.type === "ExpressionStatement" && parents.get(statement)?.type === "Program")
        return statement;
    }
    return undefined;
  };
  const aliasSources = (
    variable: object,
    read: Node,
  ): {
    writes: AliasWrite[];
    hasPriorReplacement: boolean;
  } => {
    const writes = globalAliasWrites.get(variable) ?? [];
    const readStatement = programStatement(read);
    const readOrder = readStatement ? statementOrder.get(readStatement) : undefined;
    let replacementOrder = -1;
    if (readOrder !== undefined) {
      for (const write of writes) {
        const statement = directReplacement(write);
        const order = statement ? statementOrder.get(statement) : undefined;
        if (order !== undefined && order < readOrder) {
          replacementOrder = Math.max(replacementOrder, order);
        }
      }
    }
    return {
      hasPriorReplacement: replacementOrder >= 0,
      writes: writes.filter((write) => {
        const statement = programStatement(write.identifier);
        const order = statement ? statementOrder.get(statement) : undefined;
        return order === undefined || order >= replacementOrder;
      }),
    };
  };
  const hasImmutableInitializer = (variable: object): boolean => {
    const writes = globalAliasWrites.get(variable) ?? [];
    if (writes.length !== 1) return false;
    const write = writes[0];
    const declarator = parents.get(write.identifier);
    const declaration = declarator && parents.get(declarator);
    return (
      declarator?.type === "VariableDeclarator" &&
      declarator.id === write.identifier &&
      declarator.init === write.value &&
      write.value !== undefined &&
      declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const"
    );
  };
  const isGlobalObject = (
    item: Node | undefined,
    certainty: Certainty,
    seen: ReadonlySet<object> = new Set(),
  ): boolean => {
    item = runtimeExpression(item);
    if (item === undefined) return false;
    if (globalIdentifier(item, "globalThis") || globalIdentifier(item, "global")) return true;
    if (item.type === "ConditionalExpression" || item.type === "LogicalExpression") {
      const choices =
        item.type === "ConditionalExpression"
          ? [node(item.consequent), node(item.alternate)]
          : [node(item.left), node(item.right)];
      const matches = (choice: Node | undefined) => isGlobalObject(choice, certainty, seen);
      return certainty === "definite" ? choices.every(matches) : choices.some(matches);
    }
    if (item.type !== "Identifier") return false;
    const reference = references.get(item);
    const variable = reference?.isValueReference ? reference.resolved : null;
    if (!variable || seen.has(variable)) return false;
    const next = new Set(seen);
    next.add(variable);
    const sources = aliasSources(variable, item);
    const matches = (write: AliasWrite) => isGlobalObject(write.value, certainty, next);
    return certainty === "definite"
      ? (sources.hasPriorReplacement || hasImmutableInitializer(variable)) &&
          sources.writes.length > 0 &&
          sources.writes.every(matches)
      : sources.writes.some(matches);
  };
  const isProcess = (item: Node | undefined, certainty: Certainty = "possible"): boolean => {
    if (item === undefined) return false;
    if (globalIdentifier(item, "process") || importedFrom(item, processBindings)) return true;
    return (
      item.type === "MemberExpression" &&
      memberName(item) === "process" &&
      isGlobalObject(node(item.object), certainty)
    );
  };
  const isProcessEnvironment = (item: Node, certainty: Certainty = "possible"): boolean => {
    if (importedFrom(item, environmentBindings)) return true;
    return (
      item.type === "MemberExpression" &&
      memberName(item) === "env" &&
      isProcess(node(item.object), certainty)
    );
  };
  const isEnvironment = (item: Node): boolean => {
    if (isProcessEnvironment(item)) return true;
    const object = node(item.object);
    return (
      item.type === "MemberExpression" &&
      memberName(item) === "env" &&
      object?.type === "MetaProperty" &&
      node(object.meta)?.name === "import" &&
      node(object.property)?.name === "meta"
    );
  };

  let unsupported = false;
  let runtimePortRead = false;
  const visit = (value: unknown, parent?: Node, grandparent?: Node): void => {
    const item = node(value);
    // Type queries are erased; their identifiers are not runtime reads.
    if (item === undefined || item.type === "TSTypeQuery") return;
    if (isEnvironment(item)) {
      const literalPortRead =
        parent?.type === "MemberExpression" &&
        parent.object === item &&
        memberName(parent) === "PORT";
      const writesPort =
        (grandparent?.type === "AssignmentExpression" && grandparent.left === parent) ||
        (grandparent?.type === "UpdateExpression" && grandparent.argument === parent) ||
        (grandparent?.type === "UnaryExpression" &&
          grandparent.operator === "delete" &&
          grandparent.argument === parent);
      if (!literalPortRead || writesPort) unsupported = true;
      else if (isProcessEnvironment(item, "definite")) runtimePortRead = true;
    }
    const harmlessTypeof =
      parent?.type === "UnaryExpression" &&
      parent.operator === "typeof" &&
      parent.argument === item;
    if (
      isProcess(item) &&
      !harmlessTypeof &&
      (parent?.type !== "MemberExpression" ||
        parent.object !== item ||
        memberName(parent) === undefined)
    )
      unsupported = true;
    if (
      item.type === "ImportExpression" &&
      ["process", "node:process"].includes(literal(item.source) ?? "")
    ) {
      unsupported = true;
    }
    if (
      item.type === "CallExpression" &&
      globalIdentifier(node(item.callee), "require") &&
      Array.isArray(item.arguments) &&
      ["process", "node:process"].includes(literal(item.arguments[0]) ?? "")
    ) {
      unsupported = true;
    }
    for (const key of parsed.visitorKeys[item.type] ?? []) {
      const child = item[key];
      if (Array.isArray(child)) child.forEach((entry) => visit(entry, item, parent));
      else visit(child, item, parent);
    }
  };
  visit(parsed.ast);
  return { runtimePortRead, unsupportedAccess: unsupported };
}
