import { createHash } from "node:crypto";
import path from "node:path";
import { Parser } from "htmlparser2";
import ts from "typescript";
import type { BuilderFile } from "./builder";
import type { PageMapNode, PageMapEdge, PageMapPlatform } from "./page-map";
import type { PageMapTransition, PageMapUnresolvedTransition } from "./page-map-transition";
import { hasPageMapControlCharacter } from "./page-map-path-characters";

const MAX_FILES = 500;
const MAX_FILE_CHARS = 500_000;
const MAX_TOTAL_CHARS = 8_000_000;
const MAX_EDGES = 2000;
const MAX_UNRESOLVED_TRANSITIONS = 1000;
// Bound discovery separately from each platform storage budget, so overflowing
// one kind does not immediately exhaust the other kind's available capacity.
const MAX_TRANSITION_CANDIDATES = 2 * (MAX_EDGES + MAX_UNRESOLVED_TRANSITIONS);
const MAX_CONTEXT_DEPTH = 128;

type RouterResolution = "route" | "absolute";
type SourceReference = NonNullable<PageMapTransition["evidence"][number]["source"]>;
type ConditionEvidence = {
  value: PageMapTransition["condition"];
  source: SourceReference;
};
type LinkCandidate = {
  sourceFile: string;
  target?: string;
  redirect?: boolean;
  resolution: "browser" | RouterResolution;
  browserPath?: string;
  baseUnknown?: boolean;
  declaration: SourceReference;
  transition: PageMapTransition;
};

function literal(node: ts.Node | undefined): string | undefined {
  for (let depth = 0; node && depth < MAX_CONTEXT_DEPTH; depth++) {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      node = node.expression;
    else return undefined;
  }
  return undefined;
}
function shortLabel(value: string | undefined): string | undefined {
  return value?.replace(/\s+/g, " ").trim().slice(0, 240) || undefined;
}
function jsxLabel(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sf: ts.SourceFile,
): string | undefined {
  if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) return undefined;
  const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
  for (const name of ["aria-label", "title"]) {
    const matching = attrs.filter((attr) => attr.name.getText(sf) === name);
    if (matching.length)
      return matching.length === 1 ? shortLabel(literal(matching[0].initializer)) : undefined;
  }
  if (!ts.isJsxElement(opening.parent) || opening.parent.children.length > 128) return undefined;
  let text = "";
  for (const child of opening.parent.children) {
    const part = ts.isJsxText(child) ? child.text : literal(child);
    if (part === undefined || text.length + part.length > 1024) return undefined;
    text += part;
  }
  return shortLabel(text);
}
function controlForTag(tag: string): PageMapTransition["control"]["kind"] {
  return tag === "a" ? "link" : tag === "button" ? "button" : tag === "form" ? "form" : "other";
}
/** Only describe a small predicate AST; calls, assignments and regexes are not proof. */
function boundedPredicate(expression: ts.Expression, sf: ts.SourceFile): string | undefined {
  if (expression.end - expression.getStart(sf) > 2000) return undefined;
  const pending: ts.Node[] = [expression];
  const operators = new Set([
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.LessThanToken,
    ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandToken,
    ts.SyntaxKind.BarBarToken,
  ]);
  for (let count = 0; pending.length; count++) {
    if (count >= 64) return undefined;
    const node = pending.pop()!;
    if (
      ts.isIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
        node.kind,
      )
    )
      continue;
    if (ts.isParenthesizedExpression(node)) pending.push(node.expression);
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name))
      pending.push(node.expression);
    else if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      pending.push(node.operand);
    else if (ts.isBinaryExpression(node) && operators.has(node.operatorToken.kind))
      pending.push(node.left, node.right);
    else return undefined;
  }
  return expression.getText(sf);
}
/** This is an enclosing declaration, never a reachability or execution claim. */
function enclosingCondition(
  node: ts.Node,
  sf: ts.SourceFile,
  reference: (node: ts.Node) => SourceReference,
): ConditionEvidence | undefined {
  let result: ConditionEvidence | undefined;
  let child = node;
  for (let depth = 0; child.parent && depth < MAX_CONTEXT_DEPTH; depth++) {
    const parent = child.parent;
    if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return result;
    let predicate: ts.Expression | undefined;
    let branch: "true" | "false" | undefined;
    if (ts.isIfStatement(parent)) {
      predicate = parent.expression;
      branch =
        child === parent.thenStatement
          ? "true"
          : child === parent.elseStatement
            ? "false"
            : undefined;
    } else if (ts.isConditionalExpression(parent)) {
      predicate = parent.condition;
      branch =
        child === parent.whenTrue ? "true" : child === parent.whenFalse ? "false" : undefined;
    } else if (
      ts.isForStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isTryStatement(parent) ||
      ts.isWithStatement(parent) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(parent.operatorToken.kind))
    )
      return undefined;
    if (predicate) {
      if (result || !branch) return undefined;
      const expression = boundedPredicate(predicate, sf);
      if (!expression) return undefined;
      result = { value: { kind: "predicate", expression, branch }, source: reference(predicate) };
    }
    child = parent;
  }
  return undefined;
}
function inInertJsx(node: ts.Node, sf: ts.SourceFile): boolean {
  let current: ts.Node | undefined = node;
  for (let depth = 0; current && depth < MAX_CONTEXT_DEPTH; depth++, current = current.parent) {
    if (ts.isWithStatement(current)) return true;
    if (
      ts.isJsxElement(current) &&
      ["script", "style", "template", "noscript"].includes(
        current.openingElement.tagName.getText(sf),
      )
    )
      return true;
    if (ts.isSourceFile(current)) return false;
  }
  return true;
}
function bindingIsVisible(declaration: ts.VariableDeclaration, use: ts.Node): boolean {
  let scope: ts.Node | undefined = declaration.parent;
  for (let depth = 0; scope && depth < MAX_CONTEXT_DEPTH; depth++, scope = scope.parent) {
    if (
      ts.isBlock(scope) ||
      ts.isSourceFile(scope) ||
      ts.isFunctionLike(scope) ||
      ts.isCaseBlock(scope) ||
      ts.isForStatement(scope) ||
      ts.isForInStatement(scope) ||
      ts.isForOfStatement(scope)
    ) {
      let current: ts.Node | undefined = use;
      for (let count = 0; current && count < MAX_CONTEXT_DEPTH; count++, current = current.parent)
        if (current === scope) return true;
      return false;
    }
  }
  return false;
}
function routePath(raw: string): string | null {
  if (
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    hasPageMapControlCharacter(raw, true) ||
    /[\\?#]/.test(raw)
  )
    return null;
  try {
    // Decode once for lookup, rejecting encoded separators, traversal and
    // double-encoded escapes before URL normalization can conceal them.
    const parts = raw.split("/").map((part) => decodeURIComponent(part));
    if (
      parts.some(
        (part) =>
          part === "." ||
          part === ".." ||
          part.includes("/") ||
          hasPageMapControlCharacter(part, true) ||
          /[\\?#%]/.test(part),
      )
    )
      return null;
    const normalized = parts.join("/");
    return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
function routeJoin(parent: string, child: string): string | null {
  if (child.startsWith("/")) {
    const normalized = routePath(child);
    if (!normalized) return null;
    if (
      parent !== "/" &&
      parent !== "" &&
      normalized !== parent &&
      !normalized.startsWith(parent + "/")
    )
      return null;
    return normalized;
  }
  return routePath((parent.replace(/\/$/, "") || "") + "/" + child);
}
function labelFor(route: string, component?: string): string {
  const label =
    component ?? (route === "/" ? "Home" : (route.split("/").filter(Boolean).at(-1) ?? "Page"));
  return label
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .slice(0, 160);
}
function walk(root: ts.Node, visit: (node: ts.Node) => void): boolean {
  const pending = [root];
  let count = 0;
  while (pending.length && count++ < 100_000) {
    const node = pending.pop()!;
    visit(node);
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return pending.length === 0;
}

/** Static source evidence only: never evaluates imports, routes, or project code. */
export function discoverSourcePageMap(input: BuilderFile[]): PageMapPlatform {
  let chars = 0;
  const acceptedPaths = new Set<string>();
  const files = input.slice(0, MAX_FILES).filter((file) => {
    if (file.content.length > MAX_FILE_CHARS || chars + file.content.length > MAX_TOTAL_CHARS)
      return false;
    if (
      file.path.length > 1024 ||
      hasPageMapControlCharacter(file.path) ||
      /[\\:]/.test(file.path) ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      acceptedPaths.has(file.path)
    )
      return false;
    chars += file.content.length;
    acceptedPaths.add(file.path);
    return true;
  });
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const nodesByRoute = new Map<string, PageMapNode>();
  const nodePriorities = new Map<string, number>();
  const linkCandidates: LinkCandidate[] = [];
  const sourceHashes = new Map<string, string>();
  const sourceReference = (
    file: BuilderFile,
    startOffset: number,
    endOffset: number,
  ): SourceReference => {
    let contentSha256 = sourceHashes.get(file.path);
    if (!contentSha256) {
      // Hash the supplied content as UTF-8; parser offsets index the JS string (UTF-16).
      contentSha256 = createHash("sha256").update(file.content, "utf8").digest("hex");
      sourceHashes.set(file.path, contentSha256);
    }
    return { filePath: file.path, contentSha256, startOffset, endOffset };
  };
  const addCandidate = (
    file: BuilderFile,
    declaration: SourceReference,
    details: Pick<LinkCandidate, "target" | "redirect" | "resolution" | "browserPath"> & {
      action: PageMapTransition["action"]["kind"];
      control: PageMapTransition["control"];
      outcome: PageMapTransition["outcome"]["kind"];
      condition?: ConditionEvidence;
      controlSource?: SourceReference;
    },
  ): LinkCandidate | undefined => {
    if (
      linkCandidates.length >= MAX_TRANSITION_CANDIDATES ||
      declaration.startOffset < 0 ||
      declaration.endOffset <= declaration.startOffset ||
      declaration.endOffset > file.content.length
    )
      return undefined;
    const { action, control, outcome, condition, controlSource, ...navigation } = details;
    const candidate: LinkCandidate = {
      sourceFile: file.path,
      ...navigation,
      declaration,
      transition: {
        version: 1,
        action: { kind: action },
        control,
        condition: condition?.value ?? { kind: "unknown", branch: "unknown" },
        outcome: { kind: outcome },
        destination: { kind: "unknown" },
        evidence: [
          { basis: "source", fields: ["action", "control"], source: controlSource ?? declaration },
          { basis: "source", fields: ["outcome"], source: declaration },
          condition
            ? { basis: "source", fields: ["condition"], source: condition.source }
            : { basis: "unknown", fields: ["condition"] },
        ],
        unknowns: [
          "Source declarations only; execution and branch reachability have not been verified.",
          ...(condition ? [] : ["No single bounded enclosing predicate was established."]),
        ],
      },
    };
    linkCandidates.push(candidate);
    return candidate;
  };
  const addNode = (route: string, filePath: string, label?: string, priority = 0) => {
    const normalized = routePath(route);
    if (!normalized) return;
    if (nodesByRoute.has(normalized)) {
      if (priority <= (nodePriorities.get(normalized) ?? 0)) return;
    } else if (nodesByRoute.size >= MAX_FILES) return;
    nodePriorities.set(normalized, priority);
    const text = labelFor(normalized, label);
    nodesByRoute.set(normalized, {
      id: "page-route-" + createHash("sha256").update(normalized).digest("hex").slice(0, 20),
      label: text,
      pageType: /sign.?in|log.?in|sign.?up|register/i.test(normalized)
        ? "auth"
        : /settings/i.test(normalized)
          ? "settings"
          : /dashboard/i.test(normalized)
            ? "dashboard"
            : "other",
      filePath,
      position: { x: 0, y: 0 },
      isNew: false,
      hasError: false,
      aiGenerated: true,
      notes:
        "Route: " +
        normalized +
        "\nSource-declared page. Navigation has not been runtime verified.",
    });
  };
  const resolveImport = (from: string, specifier: string): string | undefined => {
    const base =
      specifier.startsWith("./") || specifier.startsWith("../")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
        : specifier.startsWith("@/")
          ? "src/" + specifier.slice(2)
          : undefined;
    if (!base || base.startsWith("../")) return undefined;
    return [
      base,
      ...[".tsx", ".jsx", ".ts", ".js", "/index.tsx", "/index.jsx", "/index.ts", "/index.js"].map(
        (ext) => base + ext,
      ),
    ].find((candidate) => fileByPath.has(candidate));
  };
  let nextProject = false;
  for (const file of files) {
    if (file.path !== "package.json") continue;
    try {
      const pkg = JSON.parse(file.content);
      nextProject =
        typeof pkg?.dependencies?.next === "string" ||
        typeof pkg?.devDependencies?.next === "string";
    } catch {
      /* Invalid manifests are not evidence of a framework. */
    }
  }

  for (const file of files) {
    if (
      !/\.(?:[cm]?[jt]sx?)$/.test(file.path) ||
      /(?:^|\/)(?:node_modules|dist|build|\.next)\//.test(file.path) ||
      /\.(?:test|spec)\.[^.]+$/.test(file.path)
    )
      continue;
    let sf: ts.SourceFile;
    try {
      sf = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        /\.[jt]sx$/.test(file.path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
    } catch {
      continue;
    }
    const reference = (node: ts.Node) => sourceReference(file, node.getStart(sf), node.end);
    // File-wide uniqueness deliberately rejects even unrelated shadowing. No checker,
    // symbol execution, cross-function handler resolution or reassigned hook aliases.
    const bindingsByName = new Map<string, ts.Node | null>();
    let completeBindings = true;
    const declare = (name: ts.BindingName, owner: ts.Node, depth = 0): void => {
      if (depth > MAX_CONTEXT_DEPTH) {
        completeBindings = false;
        return;
      }
      if (ts.isIdentifier(name)) {
        bindingsByName.set(name.text, bindingsByName.has(name.text) ? null : owner);
      } else {
        for (const element of name.elements)
          if (ts.isBindingElement(element)) declare(element.name, owner, depth + 1);
      }
    };
    const completeWalk = walk(sf, (node) => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) declare(node.name, node);
      else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) declare(node.name, node);
      else if (ts.isImportClause(node) && node.name) declare(node.name, node);
      else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isClassDeclaration(node) ||
          ts.isClassExpression(node) ||
          ts.isEnumDeclaration(node) ||
          ts.isImportEqualsDeclaration(node)) &&
        node.name
      )
        declare(node.name, node);
      else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) declare(node.name, node);
    });
    if (!completeWalk || !completeBindings) continue;
    const importedBindings = new Map<string, ts.Node>();
    const boundImport = (name: string) =>
      importedBindings.has(name) && bindingsByName.get(name) === importedBindings.get(name);
    const imports = new Map<string, string>();
    const routeTags = new Map<string, "react-router" | "wouter">();
    const navigateTags = new Set<string>();
    const linkTags = new Map<string, { attribute: "href" | "to"; resolution: RouterResolution }>();
    const navigationHooks = new Map<string, RouterResolution>();
    const routerHooks = new Set<string>();
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const specifier = statement.moduleSpecifier.text;
      const resolved = resolveImport(file.path, specifier);
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause?.name) importedBindings.set(clause.name.text, clause);
      if (resolved && clause?.name) imports.set(clause.name.text, resolved);
      if (specifier === "next/link" && clause?.name)
        linkTags.set(clause.name.text, { attribute: "href", resolution: "absolute" });
      const bindings = clause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        if (binding.isTypeOnly) continue;
        importedBindings.set(binding.name.text, binding);
        const exported = binding.propertyName?.text ?? binding.name.text;
        if (resolved) imports.set(binding.name.text, resolved);
        if (["react-router", "react-router-dom", "wouter"].includes(specifier)) {
          const family = specifier === "wouter" ? "wouter" : "react-router";
          const resolution: RouterResolution = family === "react-router" ? "route" : "absolute";
          if (exported === "Route") routeTags.set(binding.name.text, family);
          if (exported === "Link" || (family === "react-router" && exported === "NavLink"))
            linkTags.set(binding.name.text, {
              attribute: family === "react-router" ? "to" : "href",
              resolution,
            });
          if (exported === "Navigate") {
            navigateTags.add(binding.name.text);
            linkTags.set(binding.name.text, { attribute: "to", resolution });
          }
          if (exported === "useNavigate") navigationHooks.set(binding.name.text, resolution);
        }
        if (["next/router", "next/navigation"].includes(specifier) && exported === "useRouter")
          routerHooks.add(binding.name.text);
      }
    }
    const navigators = new Map<
      string,
      { resolution: RouterResolution; declaration: ts.VariableDeclaration }
    >();
    const routers = new Map<string, ts.VariableDeclaration>();
    walk(sf, (node) => {
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        !ts.isVariableDeclarationList(node.parent) ||
        !(node.parent.flags & ts.NodeFlags.Const) ||
        bindingsByName.get(node.name.text) !== node ||
        !node.initializer ||
        !ts.isCallExpression(node.initializer) ||
        !ts.isIdentifier(node.initializer.expression) ||
        !boundImport(node.initializer.expression.text)
      )
        return;
      const resolution = navigationHooks.get(node.initializer.expression.text);
      if (resolution) navigators.set(node.name.text, { resolution, declaration: node });
      if (routerHooks.has(node.initializer.expression.text)) routers.set(node.name.text, node);
    });
    const componentFor = (
      opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
    ): { file: string; name?: string } => {
      const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
      const component = attrs.find(
        (attr) => attr.name.getText(sf) === "component" || attr.name.getText(sf) === "Component",
      );
      if (
        component?.initializer &&
        ts.isJsxExpression(component.initializer) &&
        component.initializer.expression &&
        ts.isIdentifier(component.initializer.expression)
      ) {
        const name = component.initializer.expression.text;
        return { file: imports.get(name) ?? file.path, name };
      }
      const element = attrs.find((attr) => attr.name.getText(sf) === "element");
      if (element?.initializer) {
        const candidates: string[] = [];
        walk(element.initializer, (child) => {
          if (
            ts.isJsxSelfClosingElement(child) &&
            ts.isIdentifier(child.tagName) &&
            imports.has(child.tagName.text)
          )
            candidates.push(child.tagName.text);
        });
        if (candidates.length === 1)
          return { file: imports.get(candidates[0])!, name: candidates[0] };
      }
      return { file: file.path };
    };
    const scanRoutes = (node: ts.Node, parent: string | null, depth: number): void => {
      if (depth > 128) return;
      let nextParent = parent;
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (
          routeTags.has(opening.tagName.getText(sf)) &&
          boundImport(opening.tagName.getText(sf))
        ) {
          const attrs = opening.attributes.properties.filter(ts.isJsxAttribute);
          const routeAttr = attrs.find((attr) => attr.name.getText(sf) === "path");
          const index =
            routeTags.get(opening.tagName.getText(sf)) === "react-router" &&
            attrs.some(
              (attr) =>
                attr.name.getText(sf) === "index" &&
                (!attr.initializer ||
                  (ts.isJsxExpression(attr.initializer) &&
                    attr.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword)),
            );
          const raw = literal(routeAttr?.initializer);
          nextParent =
            parent === null || (routeAttr && raw === undefined)
              ? null
              : raw === undefined
                ? parent
                : routeJoin(parent, raw);
          const renders =
            attrs.some((attr) =>
              ["element", "component", "Component"].includes(attr.name.getText(sf)),
            ) ||
            (ts.isJsxElement(node) &&
              node.children.some((child) => {
                if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) return false;
                const childOpening = ts.isJsxElement(child) ? child.openingElement : child;
                return !routeTags.has(childOpening.tagName.getText(sf));
              }));
          if (nextParent !== null && (raw !== undefined || index) && renders) {
            const component = componentFor(opening);
            // An index component is the page at its parent's URL; a layout
            // registered earlier must not take its file or navigation evidence.
            addNode(nextParent || "/", component.file, component.name, index ? 1 : 0);
          }
        }
      }
      ts.forEachChild(node, (child) => scanRoutes(child, nextParent, depth + 1));
    };
    scanRoutes(sf, "", 0);
    walk(sf, (node) => {
      if (linkCandidates.length >= MAX_TRANSITION_CANDIDATES || inInertJsx(node, sf)) return;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
        const nativeAttribute = tag === "a" ? "href" : tag === "form" ? "action" : undefined;
        const routerLink = boundImport(tag) ? linkTags.get(tag) : undefined;
        const attribute = nativeAttribute ?? routerLink?.attribute;
        if (!attribute) return;
        const destinations = attrs.filter((attr) => attr.name.getText(sf) === attribute);
        if (!destinations.length) return;
        const spread = node.attributes.properties.some(ts.isJsxSpreadAttribute);
        const relative = attrs.filter((attr) => attr.name.getText(sf) === "relative");
        const relativeValue = relative.length === 1 ? literal(relative[0].initializer) : undefined;
        const resolution = nativeAttribute ? "browser" : routerLink!.resolution;
        const redirect = navigateTags.has(tag) && !!routerLink;
        const label = jsxLabel(node, sf);
        addCandidate(file, reference(node), {
          target:
            !spread && destinations.length === 1 ? literal(destinations[0].initializer) : undefined,
          redirect,
          resolution:
            resolution === "route" &&
            relative.length &&
            (relative.length !== 1 || !["route", "path"].includes(relativeValue ?? ""))
              ? "absolute"
              : resolution,
          action: redirect ? "programmatic" : tag === "form" ? "submit" : "click",
          control: {
            kind: redirect ? "other" : routerLink ? "link" : controlForTag(tag),
            ...(label ? { label } : {}),
          },
          outcome: redirect ? "redirect" : "navigate",
          condition: enclosingCondition(node, sf, reference),
          controlSource: reference(ts.isJsxElement(node.parent) ? node.parent : node),
        });
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const navigation = ts.isIdentifier(expression)
          ? navigators.get(expression.text)
          : undefined;
        const router =
          ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          ["push", "replace"].includes(expression.name.text)
            ? routers.get(expression.expression.text)
            : undefined;
        if (
          !(navigation && bindingIsVisible(navigation.declaration, node)) &&
          !(router && bindingIsVisible(router, node))
        )
          return;
        let action: PageMapTransition["action"]["kind"] = "programmatic";
        let control: PageMapTransition["control"] = {
          kind: "call",
          label: shortLabel(expression.getText(sf)),
        };
        let controlSource = reference(node);
        let parent = node.parent;
        for (let depth = 0; parent && depth < MAX_CONTEXT_DEPTH; depth++, parent = parent.parent) {
          if (!ts.isFunctionLike(parent)) continue;
          const wrapper = parent.parent;
          if (wrapper && ts.isJsxExpression(wrapper) && ts.isJsxAttribute(wrapper.parent)) {
            const attr = wrapper.parent;
            const opening = attr.parent.parent;
            const event = attr.name.getText(sf);
            if (
              (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
              ["onClick", "onSubmit"].includes(event) &&
              !opening.attributes.properties.some(ts.isJsxSpreadAttribute) &&
              opening.attributes.properties.filter(
                (item) => ts.isJsxAttribute(item) && item.name.getText(sf) === event,
              ).length === 1
            ) {
              action = event === "onClick" ? "click" : "submit";
              const label = jsxLabel(opening, sf);
              control = {
                kind: controlForTag(opening.tagName.getText(sf)),
                ...(label ? { label } : {}),
              };
              controlSource = reference(ts.isJsxElement(opening.parent) ? opening.parent : opening);
            }
          }
          break;
        }
        addCandidate(file, reference(node), {
          target: literal(node.arguments[0]),
          // Keep the legacy coarse edge type; v1 outcome describes the operation.
          redirect: true,
          resolution: navigation?.resolution ?? "absolute",
          action,
          control,
          controlSource,
          outcome:
            router &&
            ts.isPropertyAccessExpression(expression) &&
            expression.name.text === "replace"
              ? "redirect"
              : "navigate",
          condition: enclosingCondition(node, sf, reference),
        });
      }
    });
    if (nextProject) {
      const app = /^(?:src\/)?app\/(.*\/)?page\.[jt]sx?$/.exec(file.path);
      const pages = /^(?:src\/)?pages\/(.*)\.[jt]sx?$/.exec(file.path);
      let route: string | undefined;
      if (
        app &&
        !(app[1] ?? "")
          .split("/")
          .some(
            (segment) =>
              segment.startsWith("@") || segment.startsWith("_") || segment.startsWith("(."),
          )
      ) {
        route =
          "/" +
          (app[1] ?? "")
            .split("/")
            .filter((segment) => segment && !/^\([^)]*\)$/.test(segment))
            .join("/");
      } else if (pages && !/^(?:api\/|_)/.test(pages[1])) {
        route = "/" + pages[1].replace(/(?:^|\/)index$/, "");
      }
      if (route !== undefined) addNode(route, file.path);
    }
  }

  for (const file of files) {
    if (!/\.html?$/i.test(file.path)) continue;
    let title = "";
    let overflow = 0;
    let baseUnknown = false;
    const htmlCandidates: LinkCandidate[] = [];
    const stack: Array<{
      name: string;
      ignored: boolean;
      text: string;
      candidate?: LinkCandidate;
      controlSource?: SourceReference;
    }> = [];
    const parser: Parser = new Parser(
      {
        onopentag(name, attrs) {
          if (overflow || stack.length >= MAX_CONTEXT_DEPTH) {
            overflow++;
            return;
          }
          const ignored =
            !!stack.at(-1)?.ignored || ["script", "style", "template", "noscript"].includes(name);
          const frame: (typeof stack)[number] = { name, ignored, text: "" };
          stack.push(frame);
          if (ignored) return;
          if (name === "base" && attrs.href !== undefined) baseUnknown = true;
          const target = name === "a" ? attrs.href : name === "form" ? attrs.action : undefined;
          if (target === undefined) return;
          const declaration = sourceReference(file, parser.startIndex, parser.endIndex + 1);
          const controlSource = { ...declaration };
          const label = shortLabel(attrs["aria-label"] ?? attrs.title);
          const candidate = addCandidate(file, declaration, {
            target,
            resolution: "browser",
            // Directory indexes retain their actual document URL for relative links.
            browserPath: "/" + file.path.replace(/^(?:public\/)/, ""),
            action: name === "form" ? "submit" : "click",
            control: { kind: name === "form" ? "form" : "link", ...(label ? { label } : {}) },
            outcome: "navigate",
            controlSource,
          });
          if (candidate) {
            frame.candidate = candidate;
            frame.controlSource = controlSource;
            htmlCandidates.push(candidate);
          }
        },
        ontext(text) {
          if (overflow || stack.at(-1)?.ignored) return;
          if (stack.at(-1)?.name === "title" && title.length < 160)
            title += text.slice(0, 160 - title.length);
          for (let index = stack.length - 1; index >= 0; index--) {
            const frame = stack[index];
            if (frame.name === "a" && frame.candidate) {
              frame.text += text.slice(0, Math.max(0, 1024 - frame.text.length));
              break;
            }
          }
        },
        onclosetag() {
          if (overflow) {
            overflow--;
            return;
          }
          const frame = stack.pop();
          if (!frame?.candidate || !frame.controlSource) return;
          frame.controlSource.endOffset = Math.min(
            file.content.length,
            Math.max(frame.controlSource.endOffset, parser.endIndex + 1),
          );
          if (frame.name === "a" && !frame.candidate.transition.control.label) {
            const label = shortLabel(frame.text);
            if (label) frame.candidate.transition.control.label = label;
          }
        },
      },
      { decodeEntities: true },
    );
    parser.end(file.content);
    if (baseUnknown) for (const candidate of htmlCandidates) candidate.baseUnknown = true;
    const route =
      "/" + file.path.replace(/^(?:public\/)/, "").replace(/(?:^|\/)index\.html?$/i, "");
    addNode(route, file.path, title.trim() || undefined);
  }
  const nodes = [...nodesByRoute.values()].map((node, index) => ({
    ...node,
    position: { x: 80 + (index % 3) * 340, y: 80 + Math.floor(index / 3) * 300 },
  }));
  const byFile = new Map<string, PageMapNode[]>();
  for (const node of nodes) byFile.set(node.filePath, [...(byFile.get(node.filePath) ?? []), node]);
  const routeById = new Map([...nodesByRoute].map(([route, node]) => [node.id, route]));
  const edges: PageMapEdge[] = [];
  const unresolvedTransitions: PageMapUnresolvedTransition[] = [];
  let omittedEdges = 0;
  let omittedUnresolvedTransitions = 0;
  for (const candidate of linkCandidates) {
    const { declaration, transition } = candidate;
    // A declaration in an exact content snapshot owns its identity, not its endpoints.
    const id =
      "edge-source-" +
      createHash("sha256")
        .update(
          JSON.stringify([
            declaration.filePath,
            declaration.contentSha256,
            declaration.startOffset,
            declaration.endOffset,
          ]),
        )
        .digest("hex")
        .slice(0, 20);
    const sources = byFile.get(candidate.sourceFile) ?? [];
    const source = sources.length === 1 ? sources[0] : undefined;
    if (!source)
      transition.unknowns!.push("The declaring file does not identify exactly one source page.");
    const unresolved = (reason: string) => {
      if (unresolvedTransitions.length >= MAX_UNRESOLVED_TRANSITIONS) {
        omittedUnresolvedTransitions++;
        return;
      }
      transition.unknowns!.push(reason);
      unresolvedTransitions.push({ id, ...(source ? { source: source.id } : {}), transition });
    };
    const destination = candidate.target?.trim();
    let target: PageMapNode | undefined;
    let reason = "The destination is computed, missing, or overridden by ambiguous JSX attributes.";
    if (destination !== undefined) {
      if (
        !destination ||
        destination.length > 2048 ||
        hasPageMapControlCharacter(destination, true) ||
        destination.includes("\\")
      ) {
        reason = "The literal destination is empty, oversized, or contains unsupported characters.";
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) {
        try {
          const url = new URL(destination);
          if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
            transition.destination = { kind: "external", value: destination };
            transition.outcome = { kind: "external" };
            reason = "An external destination is declared; no project page is fabricated.";
          } else reason = "The destination uses an unsupported scheme or contains credentials.";
        } catch {
          reason = "The literal destination is not a supported URL.";
        }
      } else if (destination.startsWith("//") || destination.startsWith("#")) {
        reason = "Protocol-relative and fragment-only destinations need browser context.";
      } else if (candidate.baseUnknown) {
        reason = "An HTML base declaration prevents bounded document URL resolution.";
      } else {
        const destinationPath = destination.split(/[?#]/)[0];
        const inspectedPath = destinationPath.replace(/^(?:\.\/)+/, "");
        const sourceRoute = source ? routeById.get(source.id) : undefined;
        const absolute = destinationPath.startsWith("/");
        if (
          !destinationPath ||
          !routePath(inspectedPath.startsWith("/") ? inspectedPath : "/" + inspectedPath)
        ) {
          reason = "The destination requires unsupported path normalization or traversal.";
        } else if (
          !absolute &&
          (!sourceRoute ||
            candidate.resolution === "absolute" ||
            [":", "*", "[", "]"].some((token) => sourceRoute.includes(token)))
        ) {
          reason = "The relative destination requires unresolved source or router ancestry.";
        } else {
          const base =
            candidate.resolution === "route"
              ? (sourceRoute ?? "").replace(/\/$/, "") + "/"
              : (candidate.browserPath ?? sourceRoute ?? "/");
          try {
            const resolved = new URL(destination, "https://page-map.invalid" + base);
            const pathname =
              resolved.origin === "https://page-map.invalid" ? routePath(resolved.pathname) : null;
            const value = pathname ? pathname + resolved.search + resolved.hash : undefined;
            if (
              pathname &&
              value &&
              value.length <= 2048 &&
              !hasPageMapControlCharacter(value, true) &&
              !value.includes("\\")
            ) {
              transition.destination = { kind: "route", value };
              const route = routePath(pathname.replace(/\/index\.html?$/i, "/"));
              target = (route ? nodesByRoute.get(route) : undefined) ?? nodesByRoute.get(pathname);
              reason = target
                ? "The declaration cannot be bound to a distinct source and destination page."
                : "The declared route has no discovered destination page.";
            } else reason = "The normalized destination is not a supported route.";
          } catch {
            reason = "The literal destination could not be resolved statically.";
          }
        }
      }
    }
    // A rejected literal URL does not establish a navigation outcome. Keep
    // descriptive control evidence, but neither the URL nor source authority
    // for the original default outcome survives this rejection.
    if (destination !== undefined && transition.destination.kind === "unknown") {
      transition.outcome = { kind: "unknown" };
      transition.evidence = transition.evidence.map(
        (item): PageMapTransition["evidence"][number] =>
          item.fields.includes("outcome") ? { basis: "unknown", fields: ["outcome"] } : item,
      );
    }
    transition.evidence.push(
      transition.destination.kind === "unknown"
        ? { basis: "unknown", fields: ["destination"] }
        : { basis: "source", fields: ["destination"], source: declaration },
    );
    if (!source || !target || target.id === source.id) {
      unresolved(reason);
      continue;
    }
    if (edges.length >= MAX_EDGES) {
      omittedEdges++;
      continue;
    }
    edges.push({
      id,
      source: source.id,
      target: target.id,
      connectionType: candidate.redirect ? "redirect" : "nav",
      aiGenerated: true,
      transition,
    });
  }
  const truncation: string[] = [];
  if (omittedEdges)
    truncation.push(
      "Omitted page-edge declarations from the bounded scan: " +
        omittedEdges +
        " (storage limit: " +
        MAX_EDGES +
        ").",
    );
  if (omittedUnresolvedTransitions)
    truncation.push(
      "Omitted unresolved declarations from the bounded scan: " +
        omittedUnresolvedTransitions +
        " (storage limit: " +
        MAX_UNRESOLVED_TRANSITIONS +
        ").",
    );
  if (linkCandidates.length === MAX_TRANSITION_CANDIDATES)
    truncation.push(
      "Source transition scan reached " +
        MAX_TRANSITION_CANDIDATES +
        " declarations; additional declarations may be omitted.",
    );
  // Preserve a bounded, schema-compatible disclosure even for a source-less
  // result with no page notes. Counts describe only the inspected declarations.
  const firstTransition = unresolvedTransitions[0]?.transition ?? edges[0]?.transition;
  if (firstTransition && truncation.length)
    firstTransition.unknowns = [...(firstTransition.unknowns ?? []), ...truncation];
  return { nodes, edges, ...(unresolvedTransitions.length ? { unresolvedTransitions } : {}) };
}

/** Retain identities when a prior AI map falls back to deterministic source discovery. */
export function stabilizeSourcePageMap(
  discovered: PageMapPlatform,
  existing?: PageMapPlatform,
): PageMapPlatform {
  const priorByFile = new Map<string, PageMapNode[]>();
  const priorById = new Map((existing?.nodes ?? []).map((node) => [node.id, node]));
  const counts = new Map<string, number>();
  for (const node of existing?.nodes ?? [])
    if (node.aiGenerated && !node.planned)
      priorByFile.set(node.filePath, [...(priorByFile.get(node.filePath) ?? []), node]);
  for (const node of discovered.nodes)
    counts.set(node.filePath, (counts.get(node.filePath) ?? 0) + 1);
  // Allocate inherited identities first, so a new page cannot claim the old
  // route hash of a component whose route has changed.
  const inherited = new Map<number, string>();
  const assigned = new Set<string>();
  discovered.nodes.forEach((node, index) => {
    const prior = priorByFile.get(node.filePath) ?? [];
    if (prior.length === 1 && counts.get(node.filePath) === 1 && !assigned.has(prior[0].id)) {
      inherited.set(index, prior[0].id);
      assigned.add(prior[0].id);
    }
  });
  const sourceIds = new Set(discovered.nodes.map((node) => node.id));
  const remap = new Map<string, string>();
  const nodes = discovered.nodes.map((node, index) => {
    let id = inherited.get(index);
    if (id === undefined) {
      const prior = priorById.get(node.id);
      if (
        !assigned.has(node.id) &&
        (!prior || (prior.aiGenerated && !prior.planned && prior.filePath === node.filePath))
      ) {
        id = node.id;
      } else {
        let salt = 0;
        do {
          id =
            "page-source-" +
            createHash("sha256")
              .update(JSON.stringify([node.id, node.filePath, salt++]))
              .digest("hex")
              .slice(0, 20);
        } while (assigned.has(id) || priorById.has(id) || sourceIds.has(id));
      }
      assigned.add(id);
    }
    remap.set(node.id, id);
    return id === node.id ? node : { ...node, id };
  });
  return {
    ...discovered,
    nodes,
    edges: discovered.edges.map((edge) => ({
      ...edge,
      source: remap.get(edge.source) ?? edge.source,
      target: remap.get(edge.target) ?? edge.target,
    })),
    ...(discovered.unresolvedTransitions === undefined
      ? {}
      : {
          unresolvedTransitions: discovered.unresolvedTransitions.map((candidate) => ({
            ...candidate,
            ...(candidate.source === undefined
              ? {}
              : {
                  source: remap.get(candidate.source) ?? candidate.source,
                }),
          })),
        }),
  };
}
