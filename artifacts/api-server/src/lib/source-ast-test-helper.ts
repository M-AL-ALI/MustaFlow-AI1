import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isCatchClause,
  isCaseClause,
  isCaseBlock,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isInterfaceDeclaration,
  isJsxAttribute,
  isJsxElement,
  isJsxSelfClosingElement,
  isJsxText,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isObjectLiteralExpression,
  isStringLiteralLike,
  isTryStatement,
  isVariableDeclaration,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  type Node,
} from "typescript";

type SourceKind = "ts" | "tsx";

function parseSource(source: string, sourceKind: SourceKind): SourceFile {
  return createSourceFile(
    sourceKind === "tsx" ? "source.tsx" : "source.ts",
    source,
    ScriptTarget.Latest,
    true,
    sourceKind === "tsx" ? ScriptKind.TSX : ScriptKind.TS,
  );
}

const normalizeSyntaxWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

function findNodeText(
  source: string,
  description: string,
  matches: (node: Node) => boolean,
  sourceKind: SourceKind = "ts",
): string {
  const sourceFile = parseSource(source, sourceKind);
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

export function extractNamedFunction(
  source: string,
  functionName: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `function ${functionName}`,
    (node) => isFunctionDeclaration(node) && node.name?.text === functionName,
    sourceKind,
  );
}

export function extractNamedMethod(
  source: string,
  methodName: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `method ${methodName}`,
    (node) => isMethodDeclaration(node) && node.name.getText() === methodName,
    sourceKind,
  );
}

export function extractNamedDeclaration(
  source: string,
  declarationName: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `declaration ${declarationName}`,
    (node) =>
      isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === declarationName,
    sourceKind,
  );
}

export function extractNamedInterface(
  source: string,
  interfaceName: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `interface ${interfaceName}`,
    (node) => isInterfaceDeclaration(node) && node.name.text === interfaceName,
    sourceKind,
  );
}

export function extractImportDeclaration(
  source: string,
  moduleName: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `import from ${moduleName}`,
    (node) =>
      isImportDeclaration(node) &&
      isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === moduleName,
    sourceKind,
  );
}

export function extractUniqueJsxElementByName(source: string, elementName: string): string {
  return findNodeText(
    source,
    `<${elementName}>`,
    (node) => {
      if (!isJsxElement(node) && !isJsxSelfClosingElement(node)) return false;
      const opening = isJsxElement(node) ? node.openingElement : node;
      return opening.tagName.getText() === elementName;
    },
    "tsx",
  );
}

export function extractInnermostJsxContainingText(source: string, codeText: string): string {
  const sourceFile = parseSource(source, "tsx");
  const matches: Node[] = [];

  function visit(node: Node): void {
    if (
      (isJsxElement(node) || isJsxSelfClosingElement(node)) &&
      node.getText(sourceFile).includes(codeText)
    ) {
      matches.push(node);
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (matches.length === 0) throw new Error(`Containing JSX not found: ${codeText}`);
  const match = matches.sort(
    (left, right) => left.getWidth(sourceFile) - right.getWidth(sourceFile),
  )[0]!;
  return match.getText(sourceFile);
}

export function extractObjectLiteralByStringProperty(
  source: string,
  propertyName: string,
  propertyValue: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `object ${propertyName}=${propertyValue}`,
    (node) =>
      isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) =>
          isPropertyAssignment(property) &&
          property.name.getText() === propertyName &&
          isStringLiteralLike(property.initializer) &&
          property.initializer.text === propertyValue,
      ),
    sourceKind,
  );
}

export function extractSwitchCase(
  source: string,
  caseValue: string,
  sourceKind: SourceKind = "ts",
): string {
  const sourceFile = parseSource(source, sourceKind);
  let match: Node | undefined;

  function visit(node: Node): void {
    if (
      isCaseClause(node) &&
      isStringLiteralLike(node.expression) &&
      node.expression.text === caseValue
    ) {
      if (match) throw new Error(`Multiple AST matches found: case ${caseValue}`);
      match = node;
      return;
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (!match || !isCaseClause(match)) throw new Error(`AST match not found: case ${caseValue}`);
  if (match.statements.length > 0) return match.getText(sourceFile);

  const caseBlock = match.parent;
  if (!isCaseBlock(caseBlock)) return match.getText(sourceFile);
  const start = caseBlock.clauses.indexOf(match);
  let end = start;
  while (end + 1 < caseBlock.clauses.length && caseBlock.clauses[end]?.statements.length === 0) {
    end += 1;
  }
  return source.slice(match.getStart(sourceFile), caseBlock.clauses[end]!.getEnd());
}

export function extractInnermostIfContainingIdentifier(
  source: string,
  identifierName: string,
  sourceKind: SourceKind = "ts",
): string {
  const sourceFile = parseSource(source, sourceKind);
  let declaration: Node | undefined;

  function visit(node: Node): void {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === identifierName
    ) {
      if (declaration) throw new Error(`Multiple declarations found: ${identifierName}`);
      declaration = node;
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (!declaration) throw new Error(`Declaration not found: ${identifierName}`);

  let ancestor: Node | undefined = declaration.parent;
  while (ancestor && !isIfStatement(ancestor)) ancestor = ancestor.parent;
  if (!ancestor) throw new Error(`Containing if not found: ${identifierName}`);
  return ancestor.getText(sourceFile);
}

export function extractIfStatementByCondition(
  source: string,
  conditionText: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `if (${conditionText})`,
    (node) =>
      isIfStatement(node) &&
      normalizeSyntaxWhitespace(node.expression.getText()) ===
        normalizeSyntaxWhitespace(conditionText),
    sourceKind,
  );
}

export function extractInnermostIfContainingText(
  source: string,
  codeText: string,
  sourceKind: SourceKind = "ts",
): string {
  const sourceFile = parseSource(source, sourceKind);
  const matches: Node[] = [];

  function visit(node: Node): void {
    if (isIfStatement(node) && node.getText(sourceFile).includes(codeText)) matches.push(node);
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (matches.length === 0) throw new Error(`Containing if not found: ${codeText}`);
  const match = matches.sort(
    (left, right) => left.getWidth(sourceFile) - right.getWidth(sourceFile),
  )[0]!;
  return match.getText(sourceFile);
}

export function extractCatchClauseByParameter(
  source: string,
  parameterName: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `catch (${parameterName})`,
    (node) =>
      isCatchClause(node) &&
      Boolean(
        node.variableDeclaration &&
        isIdentifier(node.variableDeclaration.name) &&
        node.variableDeclaration.name.text === parameterName,
      ),
    sourceKind,
  );
}

function subtreeHasIdentifier(node: Node, identifierName: string): boolean {
  let found = false;
  function visit(child: Node): void {
    if (isIdentifier(child) && child.text === identifierName) {
      found = true;
      return;
    }
    if (!found) forEachChild(child, visit);
  }
  visit(node);
  return found;
}

export function extractTryStatementContainingIdentifier(
  source: string,
  identifierName: string,
  sourceKind: SourceKind = "ts",
): string {
  const sourceFile = parseSource(source, sourceKind);
  let declaration: Node | undefined;

  function visit(node: Node): void {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === identifierName
    ) {
      if (declaration) throw new Error(`Multiple declarations found: ${identifierName}`);
      declaration = node;
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (!declaration) throw new Error(`Declaration not found: ${identifierName}`);

  let ancestor: Node | undefined = declaration.parent;
  while (ancestor && !isTryStatement(ancestor)) ancestor = ancestor.parent;
  if (!ancestor) throw new Error(`Containing try not found: ${identifierName}`);
  return ancestor.getText(sourceFile);
}

export function extractNearestBlockContainingDeclaration(
  source: string,
  identifierName: string,
  sourceKind: SourceKind = "ts",
): string {
  const sourceFile = parseSource(source, sourceKind);
  let declaration: Node | undefined;

  function visit(node: Node): void {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === identifierName
    ) {
      if (declaration) throw new Error(`Multiple declarations found: ${identifierName}`);
      declaration = node;
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (!declaration) throw new Error(`Declaration not found: ${identifierName}`);

  let ancestor: Node | undefined = declaration.parent;
  while (ancestor && !isBlock(ancestor)) ancestor = ancestor.parent;
  if (!ancestor) throw new Error(`Containing block not found: ${identifierName}`);
  return ancestor.getText(sourceFile);
}

export function extractNearestBlockContainingExactDeclaration(
  source: string,
  identifierName: string,
  initializerText: string,
  sourceKind: SourceKind = "ts",
): string {
  const sourceFile = parseSource(source, sourceKind);
  let declaration: Node | undefined;

  function visit(node: Node): void {
    if (
      isVariableDeclaration(node) &&
      isIdentifier(node.name) &&
      node.name.text === identifierName &&
      node.initializer &&
      normalizeSyntaxWhitespace(node.initializer.getText(sourceFile)) ===
        normalizeSyntaxWhitespace(initializerText)
    ) {
      if (declaration) throw new Error(`Multiple exact declarations found: ${identifierName}`);
      declaration = node;
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);
  if (!declaration) throw new Error(`Exact declaration not found: ${identifierName}`);

  let ancestor: Node | undefined = declaration.parent;
  while (ancestor && !isBlock(ancestor)) ancestor = ancestor.parent;
  if (!ancestor) throw new Error(`Containing block not found: ${identifierName}`);
  return ancestor.getText(sourceFile);
}

export function extractCallContainingIdentifier(
  source: string,
  callName: string,
  identifierName: string,
  sourceKind: SourceKind = "ts",
): string {
  return findNodeText(
    source,
    `${callName} call containing ${identifierName}`,
    (node) =>
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === callName &&
      subtreeHasIdentifier(node, identifierName),
    sourceKind,
  );
}

export function extractJsxElementByAttribute(
  source: string,
  elementName: string,
  attributeName: string,
  attributeValue: string,
): string {
  return findNodeText(
    source,
    `${elementName}[${attributeName}=${attributeValue}]`,
    (node) => {
      if (!isJsxElement(node) && !isJsxSelfClosingElement(node)) return false;
      const opening = isJsxElement(node) ? node.openingElement : node;
      if (opening.tagName.getText() !== elementName) return false;
      return opening.attributes.properties.some((property) => {
        if (!isJsxAttribute(property) || property.name.getText() !== attributeName) return false;
        const initializer = property.initializer;
        return Boolean(
          initializer &&
          (isStringLiteralLike(initializer) || isJsxText(initializer)) &&
          initializer.text === attributeValue,
        );
      });
    },
    "tsx",
  );
}

export function extractRouteHandler(
  source: string,
  method: string,
  routePath: string,
  sourceKind: SourceKind = "ts",
): string {
  const sourceFile = parseSource(source, sourceKind);
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
