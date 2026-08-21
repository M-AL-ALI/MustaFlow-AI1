import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isPropertyAccessExpression,
  isStringLiteralLike,
  ScriptTarget,
  type Node,
} from "typescript";

function findNodeText(
  source: string,
  description: string,
  matches: (node: Node) => boolean,
): string {
  const sourceFile = createSourceFile("source.ts", source, ScriptTarget.Latest, true);
  let match: Node | undefined;

  function visit(node: Node): void {
    if (matches(node)) {
      if (match) throw new Error(`Multiple AST matches found: ${description}`);
      match = node;
      return;
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (!match) throw new Error(`AST match not found: ${description}`);
  return match.getText(sourceFile);
}

export function extractNamedFunction(source: string, functionName: string): string {
  return findNodeText(
    source,
    `function ${functionName}`,
    (node) => isFunctionDeclaration(node) && node.name?.text === functionName,
  );
}

export function extractRouteHandler(source: string, method: string, routePath: string): string {
  const sourceFile = createSourceFile("source.ts", source, ScriptTarget.Latest, true);
  let match: Node | undefined;

  function visit(node: Node): void {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      const [path, ...remainingArguments] = node.arguments;
      const handler = remainingArguments.at(-1);
      if (
        node.expression.name.text === method &&
        path &&
        isStringLiteralLike(path) &&
        path.text === routePath &&
        handler &&
        (isArrowFunction(handler) || isFunctionExpression(handler))
      ) {
        if (match)
          throw new Error(`Multiple AST matches found: ${method.toUpperCase()} ${routePath}`);
        match = handler;
        return;
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (!match) throw new Error(`AST match not found: ${method.toUpperCase()} ${routePath}`);
  return match.getText(sourceFile);
}
