import path from "node:path";
import ts from "typescript";
import { Parser } from "htmlparser2";
import type { BuilderFile } from "./builder";
import { hasPageMapControlCharacter } from "./page-map-path-characters";
import { PageMapAnalysisValidationError } from "./page-map-validation";

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
type Import = { owner: ts.Node; module: string; name: string };
type Module = {
  file: BuilderFile;
  source: ts.SourceFile;
  bindings: Map<string, ts.Node | null>;
  imports: Map<string, Import>;
  exports: Map<string, ts.Node>;
};
type Context = {
  module: Module;
  fn?: Fn;
  args?: Map<string, Value | null>;
  primitiveStringArgs?: ReadonlySet<ts.ParameterDeclaration>;
  parent?: Context;
};
type Scope = {
  node: ts.Node;
  module: Module;
  parent?: Scope;
  fn?: ts.Node;
  bindings: Map<string, ts.Node | null>;
};
type Value = { node: ts.Node; context: Context };
type Origin = { file: BuilderFile; start: number; end: number };
type Piece = {
  text: string;
  origin?: Origin;
  part?: number;
  unknown?: boolean;
  excluded?: string;
  choices?: string[];
};
type Document = Piece[];
const UNKNOWN = "__NF_MAP_UNKNOWN__";
type Handle = {
  module: Module;
  root: boolean;
  routes: Array<{ route: string; fn: Fn; module: Module }>;
  mounts: Array<{ route: string; target: Handle }>;
};
export type ExpressPage = {
  route: string;
  documentPath: string;
  filePath: string;
  links: Array<{
    file: BuilderFile;
    start: number;
    end: number;
    ordinal: string;
    target?: string;
    kind: "link" | "form";
    baseUnknown: boolean;
    parsingUnknown: boolean;
  }>;
};

const isFn = (node: ts.Node): node is Fn =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);
const isConst = (node: ts.VariableDeclaration) =>
  ts.isVariableDeclarationList(node.parent) && !!(node.parent.flags & ts.NodeFlags.Const);
const isValueIdentifier = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  )
    return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (
    (ts.isLabeledStatement(parent) ||
      ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent)) &&
    parent.label === node
  )
    return false;
  return true;
};
const unwrap = (node: ts.Node): ts.Node => {
  for (let i = 0; i < 32; i++) {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      node = node.expression;
    else break;
  }
  return node;
};
function addBinding(bindings: Map<string, ts.Node | null>, name: ts.BindingName, owner: ts.Node) {
  const pending = [name];
  for (let count = 0; pending.length && count < 1000; count++) {
    const part = pending.pop()!;
    if (ts.isIdentifier(part)) bindings.set(part.text, bindings.has(part.text) ? null : owner);
    else
      for (const element of part.elements)
        if (ts.isBindingElement(element)) pending.push(element.name);
  }
  if (pending.length) throw new PageMapAnalysisValidationError();
}
function walkBody(root: ts.Node, visit: (node: ts.Node) => void, consume: () => void): void {
  const pending = [root];
  for (let count = 0; pending.length && count < 100_000; count++) {
    const node = pending.pop()!;
    consume();
    if (
      ts.isPropertyDeclaration(node) &&
      !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
    ) {
      // Computed names run at class definition; instance initializers do not.
      if (ts.isComputedPropertyName(node.name)) pending.push(node.name.expression);
      continue;
    }
    visit(node);
    if (node !== root && ts.isFunctionLike(node)) continue;
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  if (pending.length) throw new PageMapAnalysisValidationError();
}
function routeLiteral(node: ts.Node | undefined): string | undefined {
  if (!node || !ts.isStringLiteralLike(node)) return undefined;
  const value = node.text;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.length > 2048 ||
    /[\\?#%]/.test(value) ||
    hasPageMapControlCharacter(value, true) ||
    value.split("/").some((part) => part === "." || part === "..")
  )
    return undefined;
  return value;
}
const joinDocumentPath = (parent: string, child: string) => parent.replace(/\/+$/, "") + child;
const canonicalRoute = (route: string) => route.replace(/\/+$/, "") || "/";

const HTML_CHARACTERS = "<>\"'& \t\r\n\f";
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const neutralAttributes = (text: string) =>
  /^(?:\s+(?:class=(?:"[^"<>&]*"|'[^'<>&]*')|checked|selected|disabled))*\s*$/.test(text);

/** A deliberately strict tokenizer used only to locate an attribute's source. */
function tagShape(text: string) {
  const attributes: Array<{ name: string; start: number; end: number }> = [];
  const tag = /^<[A-Za-z][\w:-]*/.exec(text);
  if (!tag) return { state: "invalid", attributes };
  let i = tag[0].length;
  while (i < text.length) {
    const before = i;
    while (/\s/.test(text[i] ?? "") && i < text.length) i++;
    if (i === text.length) return { state: "between", attributes };
    if (text[i] === ">" || text.slice(i) === "/>") return { state: "closed", attributes };
    if (i === before && attributes.length === 0 && i === tag[0].length)
      return { state: "invalid", attributes };
    const start = i;
    const name = /^[^\s"'<>/=]+/.exec(text.slice(i));
    if (!name) return { state: "invalid", attributes };
    i += name[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === "=") {
      i++;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, i + 1);
        if (close < 0) return { state: quote, attributes };
        i = close + 1;
      } else {
        const value = /^[^\s"'=<>`]+/.exec(text.slice(i));
        if (!value) return { state: "invalid", attributes };
        i += value[0].length;
        if (i === text.length) return { state: "unquoted", attributes };
      }
    }
    attributes.push({ name: name[0].toLowerCase(), start, end: i });
  }
  return { state: "between", attributes };
}

/** Parse one composed document; uncertainty is specific to its HTML context. */
function htmlDeclarations(document: Document, consume: () => void) {
  let offset = 0;
  const ranges = document
    .filter((piece) => piece.text.length)
    .map((piece) => {
      const start = offset;
      offset += piece.text.length;
      return { ...piece, offset: start, limit: offset };
    });
  const html = ranges.map((piece) => piece.text).join("");
  const links: ExpressPage["links"] = [];
  const stack: boolean[] = [];
  const safeUnknowns = new Set<(typeof ranges)[number]>();
  const occurrences = new Map<string, number>();
  let attributes = new Set<string>();
  let duplicate = false;
  let hasPage = false;
  let baseUnknown = false;
  const parser = new Parser(
    {
      onopentagname() {
        consume();
        attributes = new Set();
        duplicate = false;
      },
      onattribute(name) {
        if (attributes.has(name)) duplicate = true;
        attributes.add(name);
      },
      onopentag(name, attrs) {
        if (stack.length >= 128) throw new PageMapAnalysisValidationError();
        const start = parser.startIndex;
        const end = parser.endIndex + 1;
        const raw = html.slice(start, end);
        // Safe text in a quoted attribute cannot change tag structure. A finite
        // complete class/boolean-attribute alternative is also structurally neutral.
        for (const piece of ranges) {
          consume();
          if (!piece.unknown || piece.offset < start || piece.limit > end) continue;
          const state = tagShape(html.slice(start, piece.offset)).state;
          if ((state === '"' || state === "'") && piece.excluded?.includes(state))
            safeUnknowns.add(piece);
          else if (
            state === "between" &&
            piece.choices?.every(neutralAttributes) &&
            /^(?:\s|\/?>)/.test(html.slice(piece.limit, end))
          )
            safeUnknowns.add(piece);
        }
        const inert =
          !!stack.at(-1) ||
          ["script", "style", "template", "noscript", "textarea", "title"].includes(name);
        stack.push(inert);
        if (inert) return;
        if (
          [
            "html",
            "body",
            "main",
            "div",
            "section",
            "article",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "p",
            "a",
            "form",
          ].includes(name)
        )
          hasPage = true;
        if (name === "base" && attrs.href !== undefined) baseUnknown = true;
        const attribute = name === "a" ? "href" : name === "form" ? "action" : undefined;
        const target = attribute ? attrs[attribute] : undefined;
        if (target === undefined) return;
        if (links.length >= 128) throw new PageMapAnalysisValidationError();
        const token = tagShape(raw).attributes.find((item) => item.name === attribute);
        const source = token
          ? ranges.find(
              (piece) =>
                !piece.unknown &&
                piece.origin &&
                piece.offset <= start + token.start &&
                piece.limit >= start + token.end,
            )
          : undefined;
        const fallback = ranges.find(
          (piece) => piece.origin && piece.offset <= start && piece.limit > start,
        );
        const declaration = source ?? fallback;
        if (!declaration?.origin) return;
        const origin = declaration.origin;
        const key = [
          origin.file.path,
          origin.start,
          origin.end,
          declaration.part ?? 0,
          source && token ? start + token.start - source.offset : start - declaration.offset,
        ].join(":");
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        links.push({
          ...origin,
          kind: name === "form" ? "form" : "link",
          ordinal: key + ":" + occurrence,
          baseUnknown: false,
          parsingUnknown: false,
          ...(!duplicate && source && !target.includes(UNKNOWN) ? { target } : {}),
        });
      },
      ontext() {
        for (const piece of ranges) {
          consume();
          if (
            piece.unknown &&
            piece.offset >= parser.startIndex &&
            piece.limit <= parser.endIndex + 1 &&
            piece.excluded?.includes("<") &&
            html.lastIndexOf("<", piece.offset - 1) <= html.lastIndexOf(">", piece.offset - 1)
          )
            safeUnknowns.add(piece);
        }
      },
      onclosetag() {
        stack.pop();
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  const parsingUnknown = ranges.some((piece) => piece.unknown && !safeUnknowns.has(piece));
  for (const link of links) {
    link.baseUnknown = baseUnknown;
    link.parsingUnknown = parsingUnknown;
  }
  return { links, hasPage, parsingUnknown };
}

/** Only balanced, context-independent fragments may stand for an array rendering. */
function repeatableFragment(document: Document, consume: () => void): boolean {
  if (htmlDeclarations(document, consume).parsingUnknown) return false;
  const stack: string[] = [];
  let valid = true;
  const parser = new Parser(
    {
      onopentag(name, _attrs, implied) {
        consume();
        if (
          implied ||
          [
            "html",
            "head",
            "body",
            "base",
            "script",
            "style",
            "title",
            "textarea",
            "template",
            "noscript",
          ].includes(name)
        )
          valid = false;
        if (!VOID_TAGS.has(name)) stack.push(name);
      },
      onclosetag(name, implied) {
        consume();
        if (VOID_TAGS.has(name)) return;
        if (implied || stack.pop() !== name) valid = false;
      },
    },
    { decodeEntities: true },
  );
  parser.end(document.map((piece) => piece.text).join(""));
  return valid && stack.length === 0;
}

/** Bounded ESM Express discovery. No imports or application code are executed. */
export function discoverExpressPages(files: BuilderFile[]): ExpressPage[] {
  // Shared budgets apply even when a graph produces no pages. Exhaustion is a
  // validation failure, never a partial map that can overwrite saved edits.
  let work = 1_000_000;
  let expandedCharacters = 8_000_000;
  let mountVisits = 4096;
  const consume = () => {
    if (--work < 0) throw new PageMapAnalysisValidationError();
  };
  const chargeDocument = (document: Document) => {
    expandedCharacters -= document.reduce((sum, piece) => sum + piece.text.length, 0);
    if (expandedCharacters < 0 || document.length > 2048)
      throw new PageMapAnalysisValidationError();
    return document;
  };
  const modules = new Map<string, Module>();
  for (const file of files) {
    if (
      !/\.[cm]?[jt]s$/.test(file.path) ||
      /(?:^|\/)(?:node_modules|dist|build|\.next)\//.test(file.path) ||
      /\.(?:test|spec)\.[^.]+$/.test(file.path)
    )
      continue;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const module: Module = {
      file,
      source,
      bindings: new Map(),
      imports: new Map(),
      exports: new Map(),
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const importedModule = statement.moduleSpecifier.text;
        const add = (name: ts.Identifier, owner: ts.Node, exported: string) => {
          addBinding(module.bindings, name, owner);
          module.imports.set(name.text, {
            owner,
            module: importedModule,
            name: exported,
          });
        };
        if (clause.name) add(clause.name, clause, "default");
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
          add(clause.namedBindings.name, clause.namedBindings, "*");
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const binding of clause.namedBindings.elements)
            if (!binding.isTypeOnly)
              add(binding.name, binding, binding.propertyName?.text ?? binding.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addBinding(module.bindings, declaration.name, declaration);
          if (
            ts.isIdentifier(declaration.name) &&
            statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          )
            module.exports.set(declaration.name.text, declaration);
        }
      } else if (ts.isFunctionDeclaration(statement)) {
        if (statement.name) addBinding(module.bindings, statement.name, statement);
        if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          const name = statement.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
            ? "default"
            : statement.name?.text;
          if (name) module.exports.set(name, statement);
        }
      } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        module.exports.set("default", statement.expression);
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const binding of statement.exportClause.elements)
          if (!binding.isTypeOnly)
            module.exports.set(binding.name.text, binding.propertyName ?? binding.name);
      } else if (
        (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
        statement.name
      ) {
        addBinding(module.bindings, statement.name, statement);
      }
    }
    modules.set(file.path, module);
  }
  const resolveModule = (from: Module, specifier: string): Module | undefined => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
    const base = path.posix.normalize(
      path.posix.join(path.posix.dirname(from.file.path), specifier),
    );
    if (base.startsWith("../") || base.startsWith("/")) return undefined;
    const replacement = /\.mjs$/.test(base)
      ? [base.replace(/\.mjs$/, ".mts")]
      : /\.cjs$/.test(base)
        ? [base.replace(/\.cjs$/, ".cts")]
        : /\.js$/.test(base)
          ? [base.replace(/\.js$/, ".ts")]
          : [];
    return [
      base,
      ...replacement,
      ...[".ts", ".js", "/index.ts", "/index.js"].map((suffix) => base + suffix),
    ]
      .map((name) => modules.get(name))
      .find((value) => value !== undefined);
  };
  const nodeScopes = new WeakMap<ts.Node, Scope>();
  for (const module of modules.values()) {
    const root: Scope = { node: module.source, module, bindings: module.bindings };
    const pending = [{ node: module.source as ts.Node, scope: root }];
    while (pending.length) {
      consume();
      const current = pending.pop()!;
      const node = current.node;
      if (ts.isTypeNode(node)) continue;
      let scope = current.scope;
      if (ts.isFunctionLike(node)) {
        if (ts.isFunctionDeclaration(node) && node.name && scope !== root)
          addBinding(scope.bindings, node.name, node);
        scope = { node, module, parent: scope, fn: node, bindings: new Map() };
        if (ts.isFunctionExpression(node) && node.name) addBinding(scope.bindings, node.name, node);
      } else if (
        ts.isBlock(node) ||
        ts.isCaseBlock(node) ||
        ts.isCatchClause(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)
      ) {
        if (ts.isClassDeclaration(node) && node.name && scope !== root)
          addBinding(scope.bindings, node.name, node);
        scope = { node, module, parent: scope, fn: scope.fn, bindings: new Map() };
      }
      nodeScopes.set(node, scope);
      if (ts.isParameter(node)) addBinding(scope.bindings, node.name, node);
      if (ts.isVariableDeclaration(node)) {
        let owner = scope;
        if (
          ts.isVariableDeclarationList(node.parent) &&
          !(node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))
        ) {
          while (owner.parent && owner.node !== owner.fn) owner = owner.parent;
        }
        if (owner !== root) addBinding(owner.bindings, node.name, node);
      } else if (ts.isEnumDeclaration(node) && scope !== root)
        addBinding(scope.bindings, node.name, node);
      ts.forEachChild(node, (child) => {
        pending.push({ node: child, scope });
      });
    }
  }
  const bindingAt = (node: ts.Identifier) => {
    for (let scope = nodeScopes.get(node); scope; scope = scope.parent) {
      consume();
      if (scope.bindings.has(node.text)) return { node: scope.bindings.get(node.text), scope };
    }
    return undefined;
  };
  const contextAt = (scope: Scope, context: Context): Context | undefined => {
    if (!scope.fn) return { module: scope.module };
    for (let candidate: Context | undefined = context; candidate; candidate = candidate.parent)
      if (candidate.fn === scope.fn && candidate.module === scope.module) return candidate;
    return undefined;
  };
  // Index assignment provenance before evaluating effects: AST traversal order must
  // not decide whether an alias can replace a native rendering operation.
  const written = new Set<ts.Node>();
  const memberWritten = new Set<ts.Node>();
  const bindingUses = new Map<ts.Node, ts.Identifier[]>();
  const bindingAssignments = new Map<ts.Node, Array<{ name: string; value: ts.Expression }>>();
  type NativeSelection = Array<string | undefined>;
  type NativeBindingSource = { value: ts.Node; selection: NativeSelection };
  const nativeAssignments = new Map<ts.Node, Array<NativeBindingSource & { name: string }>>();
  const nativeElementKey = (value: ts.Node): string | undefined => {
    value = unwrap(value);
    return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) ? value.text : undefined;
  };
  const nativeSelectionKey = (name: ts.Node | undefined): string | undefined => {
    if (!name) return undefined;
    // A property name is syntax; a computed identifier is a value, not its name.
    if (ts.isComputedPropertyName(name)) return nativeElementKey(name.expression);
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
      ? name.text
      : undefined;
  };
  const recordNativeAssignment = (
    target: ts.Node,
    value: ts.Node,
    selection: NativeSelection = [],
    depth = 0,
  ): void => {
    consume();
    if (depth > 16) throw new PageMapAnalysisValidationError();
    target = unwrap(target);
    if (ts.isIdentifier(target)) {
      const binding = bindingAt(target)?.node;
      if (binding) {
        const sources = nativeAssignments.get(binding) ?? [];
        sources.push({ name: target.text, value, selection });
        nativeAssignments.set(binding, sources);
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const item of target.properties) {
        if (ts.isShorthandPropertyAssignment(item))
          recordNativeAssignment(item.name, value, [...selection, item.name.text], depth + 1);
        else if (ts.isPropertyAssignment(item))
          recordNativeAssignment(
            item.initializer,
            value,
            [...selection, nativeSelectionKey(item.name)],
            depth + 1,
          );
        else if (ts.isSpreadAssignment(item))
          recordNativeAssignment(item.expression, value, [...selection, undefined], depth + 1);
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      target.elements.forEach((item, index) =>
        recordNativeAssignment(item, value, [...selection, String(index)], depth + 1),
      );
    } else if (ts.isSpreadElement(target))
      recordNativeAssignment(target.expression, value, [...selection, undefined], depth + 1);
    else if (
      ts.isBinaryExpression(target) &&
      target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      recordNativeAssignment(target.left, value, selection, depth + 1);
      recordNativeAssignment(target.left, target.right, [], depth + 1);
    }
  };
  const nativeBindingSources = (
    name: ts.BindingName,
    identifier: string,
    value: ts.Node,
    selection: NativeSelection = [],
    depth = 0,
  ): NativeBindingSource[] => {
    consume();
    if (depth > 16) throw new PageMapAnalysisValidationError();
    if (ts.isIdentifier(name)) return name.text === identifier ? [{ value, selection }] : [];
    const result: NativeBindingSource[] = [];
    name.elements.forEach((item, index) => {
      if (!ts.isBindingElement(item)) return;
      const key = item.dotDotDotToken
        ? undefined
        : ts.isArrayBindingPattern(name)
          ? String(index)
          : nativeSelectionKey(item.propertyName ?? item.name);
      result.push(
        ...nativeBindingSources(item.name, identifier, value, [...selection, key], depth + 1),
      );
      if (item.initializer)
        result.push(
          ...nativeBindingSources(item.name, identifier, item.initializer, [], depth + 1),
        );
    });
    return result;
  };
  const nativeEffects: ts.Node[] = [];
  for (const module of modules.values()) {
    const pending: ts.Node[] = [module.source];
    while (pending.length) {
      consume();
      const node = pending.pop()!;
      if (ts.isTypeNode(node)) continue;
      if (ts.isIdentifier(node) && isValueIdentifier(node)) {
        const binding = bindingAt(node)?.node;
        if (binding) {
          const uses = bindingUses.get(binding) ?? [];
          uses.push(node);
          bindingUses.set(binding, uses);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        recordNativeAssignment(node.left, node.right);
        const target = unwrap(node.left);
        const binding = ts.isIdentifier(target) ? bindingAt(target)?.node : undefined;
        if (binding && ts.isIdentifier(target)) {
          const assignments = bindingAssignments.get(binding) ?? [];
          assignments.push({ name: target.text, value: node.right });
          bindingAssignments.set(binding, assignments);
        }
      }
      if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isDeleteExpression(node) ||
        ts.isBinaryExpression(node) ||
        ts.isPrefixUnaryExpression(node) ||
        ts.isPostfixUnaryExpression(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node)
      )
        nativeEffects.push(node);
      ts.forEachChild(node, (child) => {
        pending.push(child);
      });
    }
  }
  let nativeStrings = true;
  let nativeArrays = true;
  let nativeBoolean = true;
  let nativeObjectReflection = true;
  let nativeReflectReflection = true;
  type NativeOwner =
    | "global"
    | "String"
    | "Array"
    | "Boolean"
    | "Object"
    | "Reflect"
    | "unknown-global";
  const nativeOwner = (
    node: ts.Node,
    depth = 0,
    selection: NativeSelection = [],
  ): NativeOwner | undefined => {
    consume();
    if (depth > 16) return "unknown-global";
    node = unwrap(node);
    const merge = (owners: Array<NativeOwner | undefined>): NativeOwner | undefined => {
      const known = new Set(owners.filter((owner): owner is NativeOwner => owner !== undefined));
      return known.size > 1 ? "unknown-global" : known.values().next().value;
    };
    const project = (owner: NativeOwner | undefined): NativeOwner | undefined => {
      for (const key of selection) {
        consume();
        if (owner !== "global") continue;
        if (
          key === "String" ||
          key === "Array" ||
          key === "Boolean" ||
          key === "Object" ||
          key === "Reflect"
        )
          owner = key;
        else if (key === "globalThis" || key === "global") owner = "global";
        else owner = key === undefined ? "unknown-global" : undefined;
      }
      return owner;
    };
    if (ts.isIdentifier(node)) {
      const found = bindingAt(node);
      if (!found) {
        if (node.text === "globalThis" || node.text === "global") return project("global");
        if (
          node.text === "String" ||
          node.text === "Array" ||
          node.text === "Boolean" ||
          node.text === "Object" ||
          node.text === "Reflect"
        )
          return project(node.text);
        return undefined;
      }
      const binding = found.node;
      if (!binding || !ts.isVariableDeclaration(binding)) return undefined;
      const sources = binding.initializer
        ? nativeBindingSources(binding.name, node.text, binding.initializer)
        : [];
      sources.push(
        ...(nativeAssignments.get(binding) ?? []).filter((item) => item.name === node.text),
      );
      return merge(
        sources.map((source) =>
          nativeOwner(source.value, depth + 1, [...source.selection, ...selection]),
        ),
      );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : nativeElementKey(node.argumentExpression);
      return nativeOwner(node.expression, depth + 1, [key, ...selection]);
    }
    if (ts.isConditionalExpression(node))
      return merge([
        nativeOwner(node.whenTrue, depth + 1, selection),
        nativeOwner(node.whenFalse, depth + 1, selection),
      ]);
    if (!selection.length) return undefined;
    const [key, ...remaining] = selection;
    if (ts.isObjectLiteralExpression(node)) {
      if (node.properties.some(ts.isSpreadAssignment)) return "unknown-global";
      return merge(
        node.properties
          .filter(
            (item) =>
              key === undefined ||
              nativeSelectionKey(item.name) === undefined ||
              nativeSelectionKey(item.name) === key,
          )
          .map((item) =>
            ts.isPropertyAssignment(item)
              ? nativeOwner(item.initializer, depth + 1, remaining)
              : ts.isShorthandPropertyAssignment(item)
                ? nativeOwner(item.name, depth + 1, remaining)
                : undefined,
          ),
      );
    }
    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.some(ts.isSpreadElement)) return "unknown-global";
      return merge(
        node.elements
          .filter((_item, index) => key === undefined || String(index) === key)
          .map((item) => nativeOwner(item, depth + 1, remaining)),
      );
    }
    return undefined;
  };
  const invalidateNative = (owner: NativeOwner | undefined): void => {
    if (owner === "String" || owner === "unknown-global") nativeStrings = false;
    if (owner === "Array" || owner === "unknown-global") nativeArrays = false;
    if (owner === "Boolean" || owner === "unknown-global") nativeBoolean = false;
    if (owner === "Object" || owner === "unknown-global") nativeObjectReflection = false;
    if (owner === "Reflect" || owner === "unknown-global") nativeReflectReflection = false;
  };
  const markWritten = (node: ts.Node, memberWrite = false, depth = 0): void => {
    consume();
    if (depth > 16) throw new PageMapAnalysisValidationError();
    node = unwrap(node);
    // Rebinding a local alias is not a mutation of the value it may reference.
    if (depth === 0 && (memberWrite || !ts.isIdentifier(node) || !bindingAt(node)))
      invalidateNative(nativeOwner(node));
    if (ts.isIdentifier(node)) {
      const binding = bindingAt(node)?.node;
      if (!binding) {
        if (node.text === "String") nativeStrings = false;
        if (node.text === "Array") nativeArrays = false;
        if (node.text === "Boolean") nativeBoolean = false;
        return;
      }
      written.add(binding);
      if (memberWrite) {
        if (memberWritten.has(binding)) return;
        memberWritten.add(binding);
        if (
          ts.isVariableDeclaration(binding) &&
          binding.initializer &&
          (ts.isIdentifier(unwrap(binding.initializer)) ||
            ts.isPropertyAccessExpression(unwrap(binding.initializer)) ||
            ts.isElementAccessExpression(unwrap(binding.initializer)))
        )
          markWritten(binding.initializer, true, depth + 1);
      }
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      markWritten(node.expression, true, depth + 1);
    else if (ts.isArrayLiteralExpression(node))
      node.elements.forEach((element) => markWritten(element, memberWrite, depth + 1));
    else if (ts.isObjectLiteralExpression(node))
      node.properties.forEach((part) => {
        if (ts.isShorthandPropertyAssignment(part)) markWritten(part.name, memberWrite, depth + 1);
        else if (ts.isPropertyAssignment(part))
          markWritten(part.initializer, memberWrite, depth + 1);
        else if (ts.isSpreadAssignment(part)) markWritten(part.expression, memberWrite, depth + 1);
      });
    else if (ts.isSpreadElement(node)) markWritten(node.expression, memberWrite, depth + 1);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      markWritten(node.left, memberWrite, depth + 1);
  };
  const reflectionCandidate = (node: ts.Node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    ["Object", "Reflect"].includes(node.expression.expression.text) &&
    !bindingAt(node.expression.expression) &&
    [
      "assign",
      "defineProperty",
      "defineProperties",
      "set",
      "setPrototypeOf",
      "deleteProperty",
    ].includes(node.expression.name.text) &&
    node.arguments[0]
      ? {
          target: node.arguments[0],
          key: node.arguments[1],
          method: node.expression.name.text,
          owner: node.expression.expression.text,
        }
      : undefined;
  const invalidateEscapingNative = (argument: ts.Node): void => {
    const owner = nativeOwner(argument);
    if (owner === "global") invalidateNative("unknown-global");
    else if (owner !== "Boolean") invalidateNative(owner);
  };
  // First collect every visible write and escape, including replacement of the
  // reflection helpers themselves. No precise native-helper exemption is granted yet.
  for (const node of nativeEffects) {
    consume();
    const candidate = reflectionCandidate(node);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      for (const [index, argument] of (node.arguments ?? []).entries()) {
        if (index !== 0 || !candidate) invalidateEscapingNative(argument);
      }
    }
    if (ts.isDeleteExpression(node)) markWritten(node.expression, true);
    if (candidate) {
      const { target, key, method } = candidate;
      if (nativeOwner(target) === "global") {
        const singleKey = ["defineProperty", "set", "deleteProperty"].includes(method);
        invalidateNative(
          singleKey && key && ts.isStringLiteralLike(key)
            ? key.text === "String" ||
              key.text === "Array" ||
              key.text === "Boolean" ||
              key.text === "Object" ||
              key.text === "Reflect"
              ? key.text
              : undefined
            : "unknown-global",
        );
      }
      markWritten(target, true);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      markWritten(node.left);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    )
      markWritten(node.operand);
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      markWritten(node.initializer);
  }
  // A replaced helper is an arbitrary call, even with an unrelated property key.
  // Process these deferred targets after all helper mutations have been collected.
  for (const node of nativeEffects) {
    consume();
    const candidate = reflectionCandidate(node);
    if (
      candidate &&
      !(candidate.owner === "Object" ? nativeObjectReflection : nativeReflectReflection)
    )
      invalidateEscapingNative(candidate.target);
  }
  const reference = (value: Value, depth = 0): Value | undefined => {
    consume();
    if (depth > 16) return undefined;
    const node = unwrap(value.node);
    if (!ts.isIdentifier(node)) return { ...value, node };
    const found = bindingAt(node);
    if (!found?.node) return undefined;
    const binding = found.node;
    if (written.has(binding)) return undefined;
    if (
      (ts.isParameter(binding) || ts.isVariableDeclaration(binding)) &&
      !ts.isIdentifier(binding.name)
    )
      return undefined;
    if (ts.isParameter(binding) && binding.dotDotDotToken) return undefined;
    const context = contextAt(found.scope, value.context);
    if (!context) return undefined;
    if (ts.isParameter(binding)) {
      const argument = context.args?.has(node.text)
        ? context.args.get(node.text)
        : binding.initializer
          ? { node: binding.initializer, context }
          : undefined;
      return argument ? reference(argument, depth + 1) : undefined;
    }
    const imported = found.scope.module.imports.get(node.text);
    if (imported?.owner === binding) {
      const target = resolveModule(found.scope.module, imported.module);
      const exported = target?.exports.get(imported.name);
      return target && exported
        ? reference({ node: exported, context: { module: target } }, depth + 1)
        : undefined;
    }
    return { node: binding, context };
  };
  const handles = new Map<ts.Node, Handle>();
  for (const module of modules.values()) {
    for (const binding of module.bindings.values()) {
      if (
        !binding ||
        !ts.isVariableDeclaration(binding) ||
        !isConst(binding) ||
        !binding.initializer ||
        !ts.isCallExpression(binding.initializer)
      )
        continue;
      const factory = binding.initializer.expression;
      const name = ts.isIdentifier(factory)
        ? factory.text
        : ts.isPropertyAccessExpression(factory) &&
            ts.isIdentifier(factory.expression) &&
            factory.name.text === "Router"
          ? factory.expression.text
          : undefined;
      const imported = name ? module.imports.get(name) : undefined;
      if (
        !imported ||
        module.bindings.get(name!) !== imported.owner ||
        imported.module !== "express"
      )
        continue;
      const root = ts.isIdentifier(factory) && imported.name === "default";
      const router = ts.isIdentifier(factory)
        ? imported.name === "Router"
        : ["default", "*"].includes(imported.name);
      if (root || router) handles.set(binding, { module, root, routes: [], mounts: [] });
    }
  }
  for (const module of modules.values()) {
    for (const statement of module.source.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
        continue;
      const call = statement.expression;
      if (
        !ts.isPropertyAccessExpression(call.expression) ||
        !ts.isIdentifier(call.expression.expression)
      )
        continue;
      const binding = reference({ node: call.expression.expression, context: { module } });
      const handle = binding && handles.get(binding.node);
      if (!handle) continue;
      if (call.expression.name.text === "use") {
        const route = routeLiteral(call.arguments[0]);
        const arguments_ = route === undefined ? call.arguments : call.arguments.slice(1);
        if (route === undefined && call.arguments.length !== 1) continue;
        for (const argument of arguments_) {
          const targetBinding = reference({ node: argument, context: { module } });
          const target = targetBinding && handles.get(targetBinding.node);
          if (target) handle.mounts.push({ route: route ?? "/", target });
        }
      } else if (call.expression.name.text === "get") {
        const route = routeLiteral(call.arguments[0]);
        const last = call.arguments.at(-1);
        const handler = last && reference({ node: last, context: { module } });
        if (route !== undefined && handler && isFn(handler.node))
          handle.routes.push({ route, fn: handler.node, module: handler.context.module });
      }
    }
  }
  const unknown = (excluded = "", choices?: string[]): Document[] => [
    [
      {
        text:
          choices?.length && choices.every(neutralAttributes)
            ? (choices.find((choice) => choice.length > 0) ?? UNKNOWN)
            : UNKNOWN,
        unknown: true,
        excluded,
        ...(choices ? { choices } : {}),
      },
    ],
  ];
  const excludedIn = (documents: Document[]) =>
    [...HTML_CHARACTERS]
      .filter((character) =>
        documents.every((document) =>
          document.every((piece) =>
            piece.unknown ? piece.excluded?.includes(character) : !piece.text.includes(character),
          ),
        ),
      )
      .join("");
  const alternatives = (documents: Document[]): Document[] => {
    // Re-normalizing one summary must not discard finite choices or source provenance.
    if (documents.length <= 1) return documents;
    if (documents.length > 128) throw new PageMapAnalysisValidationError();
    const excluded = excludedIn(documents);
    if (excluded.includes("<") && excluded.includes(">")) {
      const choices = documents.every((document) => document.every((piece) => !piece.unknown))
        ? [...new Set(documents.map((document) => document.map((piece) => piece.text).join("")))]
        : undefined;
      if (choices?.length === 1) return [documents[0]];
      return unknown(excluded, choices);
    }
    return documents;
  };
  const combine = (left: Document[], right: Document[]): Document[] => {
    if (left.length * right.length > 128) throw new PageMapAnalysisValidationError();
    return left.flatMap((a) => right.map((b) => chargeDocument([...a, ...b])));
  };
  const routeFunctions = new Set(
    [...handles.values()].flatMap((handle) => handle.routes.map((route) => route.fn)),
  );
  const propertyKey = (node: ts.Node): string | undefined =>
    ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
  const objectProperty = (value: Value, key: string, depth = 0): Value[] | undefined => {
    consume();
    if (depth > 16) return undefined;
    const resolved = reference(value);
    if (!resolved) return undefined;
    const { node, context } = resolved;
    if (ts.isVariableDeclaration(node) && isConst(node) && node.initializer)
      return objectProperty({ node: node.initializer, context }, key, depth + 1);
    if (ts.isConditionalExpression(node)) {
      const left = objectProperty({ node: node.whenTrue, context }, key, depth + 1);
      const right = objectProperty({ node: node.whenFalse, context }, key, depth + 1);
      if (!left || !right || left.length + right.length > 32) return undefined;
      return [...left, ...right];
    }
    if (!ts.isObjectLiteralExpression(node)) return undefined;
    const names = new Set<string>();
    let result: Value | undefined;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return undefined;
      const name = propertyKey(property.name);
      if (!name || name === "__proto__" || names.has(name)) return undefined;
      names.add(name);
      if (name === key) result = { node: property.initializer, context };
    }
    return result ? [result] : undefined;
  };
  const literalValue = (
    value: Value,
    depth = 0,
  ): { value: string | number | boolean | null | undefined } | undefined => {
    consume();
    if (depth > 16) return undefined;
    const resolved = reference(value);
    if (!resolved) {
      const node = unwrap(value.node);
      return ts.isIdentifier(node) && node.text === "undefined" && !bindingAt(node)
        ? { value: undefined }
        : undefined;
    }
    const { node, context } = resolved;
    if (ts.isVariableDeclaration(node) && isConst(node) && node.initializer)
      return literalValue({ node: node.initializer, context }, depth + 1);
    if (ts.isStringLiteralLike(node)) return { value: node.text };
    if (ts.isNumericLiteral(node)) return { value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { value: null };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
    return undefined;
  };
  const requestParams = (node: ts.Node): boolean => {
    node = unwrap(node);
    if (!(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) return false;
    const key = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    const request = unwrap(node.expression);
    if (key !== "params" || !ts.isIdentifier(request)) return false;
    const found = bindingAt(request);
    return (
      !!found?.node &&
      ts.isParameter(found.node) &&
      !written.has(found.node) &&
      [...routeFunctions].some((fn) => fn.parameters[0] === found.node)
    );
  };
  /** Grant native string semantics from the expression, never a helper name or annotation alone. */
  const primitiveString = (value: Value, depth = 0): boolean => {
    consume();
    if (depth > 20 || !nativeStrings) return false;
    const raw = unwrap(value.node);
    if (ts.isIdentifier(raw)) {
      const found = bindingAt(raw);
      const binding = found?.node;
      const context = found && contextAt(found.scope, value.context);
      if (!binding || !context || written.has(binding)) return false;
      if (ts.isParameter(binding)) {
        if (context.args?.get(raw.text) === null && context.primitiveStringArgs?.has(binding))
          return true;
        const argument = context.args?.has(raw.text)
          ? context.args.get(raw.text)
          : binding.initializer
            ? { node: binding.initializer, context }
            : undefined;
        return !!argument && primitiveString(argument, depth + 1);
      }
      if (ts.isVariableDeclaration(binding)) {
        if (
          ts.isObjectBindingPattern(binding.name) &&
          binding.initializer &&
          requestParams(binding.initializer)
        )
          return binding.name.elements.some(
            (element) =>
              !element.dotDotDotToken &&
              ts.isIdentifier(element.name) &&
              element.name.text === raw.text &&
              (!element.initializer ||
                primitiveString({ node: element.initializer, context }, depth + 1)) &&
              (!element.propertyName || propertyKey(element.propertyName) !== undefined),
          );
        return (
          isConst(binding) &&
          ts.isIdentifier(binding.name) &&
          !!binding.initializer &&
          primitiveString({ node: binding.initializer, context }, depth + 1)
        );
      }
      return false;
    }
    const resolved = reference(value);
    if (!resolved) return false;
    const { node, context } = resolved;
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return true;
    if (ts.isConditionalExpression(node))
      return (
        primitiveString({ node: node.whenTrue, context }, depth + 1) &&
        primitiveString({ node: node.whenFalse, context }, depth + 1)
      );
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken)
        return (
          primitiveString({ node: node.left, context }, depth + 1) ||
          primitiveString({ node: node.right, context }, depth + 1)
        );
      if (
        [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
          node.operatorToken.kind,
        )
      )
        return (
          primitiveString({ node: node.left, context }, depth + 1) &&
          primitiveString({ node: node.right, context }, depth + 1)
        );
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      if (!key) return false;
      if (requestParams(node.expression)) return true;
      const values = objectProperty({ node: node.expression, context }, key);
      return !!values?.length && values.every((item) => primitiveString(item, depth + 1));
    }
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "String" &&
        !bindingAt(node.expression)
      )
        return true;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        primitiveString({ node: node.expression.expression, context }, depth + 1)
      ) {
        if (
          [
            "trim",
            "trimStart",
            "trimEnd",
            "slice",
            "substring",
            "toLowerCase",
            "toUpperCase",
          ].includes(node.expression.name.text)
        )
          return true;
        if (
          node.expression.name.text === "replace" &&
          node.arguments.length === 2 &&
          ts.isRegularExpressionLiteral(node.arguments[0]) &&
          /^\/([&<>"'])\/g$/.test(node.arguments[0].text) &&
          ts.isStringLiteralLike(node.arguments[1]) &&
          !node.arguments[1].text.includes("$")
        )
          return true;
      }
      let callee = reference({ node: node.expression, context });
      if (
        callee &&
        ts.isVariableDeclaration(callee.node) &&
        isConst(callee.node) &&
        callee.node.initializer
      )
        callee = { node: unwrap(callee.node.initializer), context: callee.context };
      if (
        !callee ||
        !isFn(callee.node) ||
        !callee.node.body ||
        ("asteriskToken" in callee.node && !!callee.node.asteriskToken) ||
        callee.node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      )
        return false;
      const fn = callee.node;
      const args = new Map<string, Value | null>();
      fn.parameters.forEach((parameter, index) => {
        if (ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken && node.arguments[index])
          args.set(parameter.name.text, { node: node.arguments[index], context });
      });
      const next: Context = { module: callee.context.module, fn, args, parent: callee.context };
      const body = fn.body;
      if (!body) return false;
      if (!ts.isBlock(body)) return primitiveString({ node: body, context: next }, depth + 1);
      let returns = 0;
      let valid = true;
      walkBody(
        body,
        (child) => {
          if (ts.isReturnStatement(child)) {
            returns++;
            valid &&=
              !!child.expression &&
              primitiveString({ node: child.expression, context: next }, depth + 1);
          }
        },
        consume,
      );
      return returns > 0 && valid;
    }
    return false;
  };
  const collectFunction = (
    fn: Fn,
    context: Context,
    arguments_: Array<Value | null>,
    budget: { left: number },
    depth: number,
    firstArgumentIsString = false,
  ): Document[] => {
    if (
      !fn.body ||
      ("asteriskToken" in fn && fn.asteriskToken) ||
      fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      return unknown();
    const args = new Map<string, Value | null>();
    fn.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name) && !parameter.dotDotDotToken && index < arguments_.length)
        args.set(parameter.name.text, arguments_[index]);
    });
    const primitiveStringArgs = new Set<ts.ParameterDeclaration>();
    const first = fn.parameters[0];
    if (
      firstArgumentIsString &&
      first &&
      ts.isIdentifier(first.name) &&
      !first.dotDotDotToken &&
      arguments_[0] === null
    )
      primitiveStringArgs.add(first);
    const next: Context = {
      module: context.module,
      fn,
      args,
      primitiveStringArgs,
      parent: context,
    };
    if (!ts.isBlock(fn.body))
      return alternatives(collectHtml({ node: fn.body, context: next }, budget, depth + 1));
    const result: Document[] = [];
    walkBody(
      fn.body,
      (child) => {
        if (ts.isReturnStatement(child) && child.expression)
          result.push(...collectHtml({ node: child.expression, context: next }, budget, depth + 1));
        if (result.length > 128) throw new PageMapAnalysisValidationError();
      },
      consume,
    );
    return result.length ? alternatives(result) : unknown();
  };
  // The array contract is a source declaration, not evidence of executed iteration.
  const supportedNativeSplit = (node: ts.CallExpression, context: Context): boolean =>
    nativeStrings &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "split" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    primitiveString({ node: node.expression.expression, context });
  const supportedNativeFilter = (node: ts.CallExpression): boolean => {
    const predicate = node.arguments[0];
    return (
      nativeBoolean &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "filter" &&
      node.arguments.length === 1 &&
      !!predicate &&
      ts.isIdentifier(predicate) &&
      predicate.text === "Boolean" &&
      !bindingAt(predicate)
    );
  };
  // Method ownership is required even when the map callback ignores its element.
  // Keep this separate from element typing: database-backed arrays may be reassigned.
  const arrayUsesStayLocal = (
    binding: ts.VariableDeclaration | ts.ParameterDeclaration,
    operation: ts.CallExpression,
    seen = new Map<ts.Node, Set<string>>(),
    depth = 0,
    referenceName = ts.isIdentifier(binding.name) ? binding.name.text : undefined,
    returnedValues: ReadonlySet<ts.Node> = new Set(),
  ): boolean => {
    consume();
    if (depth > 12 || !referenceName) return false;
    if (seen.get(binding)?.has(referenceName)) return true;
    const names = seen.get(binding) ?? new Set<string>();
    names.add(referenceName);
    seen.set(binding, names);
    if (
      memberWritten.has(binding) ||
      (ts.getCombinedModifierFlags(binding) & ts.ModifierFlags.Export) !== 0
    )
      return false;
    for (const use of bindingUses.get(binding) ?? []) {
      consume();
      if (use.text !== referenceName) continue;
      if (use.pos >= binding.name.pos && use.end <= binding.name.end) continue;
      let expression: ts.Node = use;
      while (
        expression.parent &&
        (ts.isParenthesizedExpression(expression.parent) ||
          ts.isAsExpression(expression.parent) ||
          ts.isTypeAssertionExpression(expression.parent) ||
          ts.isSatisfiesExpression(expression.parent))
      )
        expression = expression.parent;
      const parent = expression.parent;
      if (returnedValues.has(expression)) continue;
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === expression &&
        arrayUsesStayLocal(parent, operation, seen, depth + 1, undefined, returnedValues)
      )
        continue;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        if (
          (ts.isParameter(binding) || (ts.isVariableDeclaration(binding) && !isConst(binding))) &&
          parent.left === expression
        )
          continue;
        const target = unwrap(parent.left);
        const targetBinding = ts.isIdentifier(target) ? bindingAt(target)?.node : undefined;
        if (
          parent.right === expression &&
          targetBinding &&
          ts.isVariableDeclaration(targetBinding) &&
          ts.isIdentifier(target) &&
          arrayUsesStayLocal(targetBinding, operation, seen, depth + 1, target.text, returnedValues)
        )
          continue;
      }
      if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === expression &&
        (parent.name.text === "length" ||
          (parent === operation.expression &&
            (parent.name.text === "map" || parent.name.text === "filter")))
      )
        continue;
      return false;
    }
    return true;
  };
  const arrayProducerPropertyKey = (name: ts.PropertyName | undefined): string | undefined =>
    name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
      ? name.text
      : undefined;
  // An array annotation supplies a source-level shape contract, not permission
  // to ignore a visible producer, alias escape, reassignment or custom method.
  const arrayProducerIsLocal = (
    value: Value,
    operation: ts.CallExpression,
    seen = new Map<ts.Node, Set<string>>(),
    depth = 0,
    returnedValues: ReadonlySet<ts.Node> = new Set(),
  ): boolean => {
    consume();
    if (depth > 12) return false;
    const node = unwrap(value.node);
    if (ts.isIdentifier(node)) {
      const found = bindingAt(node);
      const binding = found?.node;
      if (!binding || (!ts.isVariableDeclaration(binding) && !ts.isParameter(binding)))
        return false;
      if (!arrayUsesStayLocal(binding, operation, new Map(), 0, node.text, returnedValues))
        return false;
      if (ts.isParameter(binding)) {
        const context = found && contextAt(found.scope, value.context);
        const assignmentsSafe = () =>
          (bindingAssignments.get(binding) ?? [])
            .filter((assignment) => assignment.name === node.text)
            .every((assignment) =>
              arrayProducerIsLocal(
                { node: assignment.value, context: value.context },
                operation,
                seen,
                depth + 1,
                returnedValues,
              ),
            );
        // Rest parameters create a fresh array; their elements gain no string proof.
        if (binding.dotDotDotToken) return assignmentsSafe();
        if (context?.args?.has(node.text)) {
          const argument =
            context.args.get(node.text) ??
            (binding.initializer ? { node: binding.initializer, context } : undefined);
          if (!argument) return false;
          const transfers = new Set(returnedValues);
          // Permit only actual arguments whose corresponding parameter uses were
          // checked. Another alias passed to a mutating parameter is not exempt.
          for (const parameter of context.fn?.parameters ?? []) {
            if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) continue;
            const actual = context.args.get(parameter.name.text);
            if (
              actual &&
              arrayUsesStayLocal(
                parameter,
                operation,
                new Map(),
                0,
                parameter.name.text,
                returnedValues,
              )
            )
              transfers.add(unwrap(actual.node));
          }
          // Recheck actual arguments before cycle shortcuts, including calls to
          // the same factory with different inputs.
          return (
            arrayProducerIsLocal(argument, operation, seen, depth + 1, transfers) &&
            assignmentsSafe()
          );
        }
      }
      if (seen.get(binding)?.has(node.text)) return true;
      const names = seen.get(binding) ?? new Set<string>();
      names.add(node.text);
      seen.set(binding, names);
      if (binding.initializer) {
        if (ts.isIdentifier(binding.name)) {
          if (
            !arrayProducerIsLocal(
              { node: binding.initializer, context: value.context },
              operation,
              seen,
              depth + 1,
              returnedValues,
            )
          )
            return false;
        } else {
          if (!ts.isObjectBindingPattern(binding.name)) return false;
          const element = binding.name.elements.find(
            (item) => ts.isIdentifier(item.name) && item.name.text === node.text,
          );
          if (!element || element.dotDotDotToken || element.initializer) return false;
          let producer = unwrap(binding.initializer);
          if (ts.isAwaitExpression(producer)) producer = unwrap(producer.expression);
          if (ts.isObjectLiteralExpression(producer)) {
            if (producer.properties.some(ts.isSpreadAssignment)) return false;
            const key = arrayProducerPropertyKey(
              element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined),
            );
            const properties = producer.properties.filter(
              (property) =>
                !ts.isSpreadAssignment(property) && arrayProducerPropertyKey(property.name) === key,
            );
            if (!key || properties.length !== 1) return false;
            const property = properties[0];
            const item = ts.isPropertyAssignment(property)
              ? property.initializer
              : ts.isShorthandPropertyAssignment(property)
                ? property.name
                : undefined;
            if (
              !item ||
              !arrayProducerIsLocal(
                { node: item, context: value.context },
                operation,
                seen,
                depth + 1,
                returnedValues,
              )
            )
              return false;
          } else {
            const key = arrayProducerPropertyKey(
              element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined),
            );
            if (
              !ts.isCallExpression(producer) ||
              !key ||
              !arrayCallProducerIsLocal(
                { node: producer, context: value.context },
                operation,
                seen,
                depth + 1,
                returnedValues,
                key,
              )
            )
              return false;
          }
          // Opaque query results retain the declared array contract, but their
          // named local binding must still have no observed mutation or escape.
        }
      }
      return (bindingAssignments.get(binding) ?? [])
        .filter((assignment) => assignment.name === node.text)
        .every((assignment) =>
          arrayProducerIsLocal(
            { node: assignment.value, context: value.context },
            operation,
            seen,
            depth + 1,
            returnedValues,
          ),
        );
    }
    if (
      ts.isObjectLiteralExpression(node) ||
      ts.isClassExpression(node) ||
      ts.isNewExpression(node)
    )
      return false;
    if (ts.isAwaitExpression(node))
      return arrayProducerIsLocal(
        { node: node.expression, context: value.context },
        operation,
        seen,
        depth + 1,
        returnedValues,
      );
    if (ts.isConditionalExpression(node))
      return (
        arrayProducerIsLocal(
          { node: node.whenTrue, context: value.context },
          operation,
          seen,
          depth + 1,
          returnedValues,
        ) &&
        arrayProducerIsLocal(
          { node: node.whenFalse, context: value.context },
          operation,
          seen,
          depth + 1,
          returnedValues,
        )
      );
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["split", "filter"].includes(node.expression.name.text)
    )
      return declaredArray(value, operation, depth + 1);
    if (ts.isCallExpression(node))
      return arrayCallProducerIsLocal(value, operation, seen, depth + 1, returnedValues);
    return ts.isArrayLiteralExpression(node);
  };
  // Opaque query calls retain a declared shape contract. A visible local factory
  // is different: its returned values must pass the same ownership checks.
  // Language intrinsics and global namespace objects are not external data
  // providers. Unsupported reflective construction must keep its result unknown.
  const intrinsicFactoryRoots = new Set([
    "eval",
    "Array",
    "Object",
    "Reflect",
    "Function",
    "Proxy",
    "Promise",
    "String",
    "Number",
    "Boolean",
    "BigInt",
    "Symbol",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "WeakRef",
    "FinalizationRegistry",
    "ArrayBuffer",
    "SharedArrayBuffer",
    "DataView",
    "JSON",
    "Math",
    "Atomics",
    "Intl",
    "WebAssembly",
    "globalThis",
    "global",
    "window",
    "self",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ]);
  type ArrayReceiverSource = {
    kind: "source" | "opaque" | "unknown";
    value?: Value;
    bindings: ts.VariableDeclaration[];
    transfers: Set<ts.Node>;
  };
  // This recovers source provenance, not a general value substitution. The selected
  // method's uses are checked separately before any recovered body is trusted.
  const arrayReceiverSource = (value: Value, depth = 0): ArrayReceiverSource => {
    consume();
    const unknownReceiver = (): ArrayReceiverSource => ({
      kind: "unknown",
      bindings: [],
      transfers: new Set(),
    });
    if (depth > 12) return unknownReceiver();
    const node = unwrap(value.node);
    if (ts.isIdentifier(node)) {
      const found = bindingAt(node);
      if (!found?.node)
        return intrinsicFactoryRoots.has(node.text)
          ? unknownReceiver()
          : { kind: "opaque", bindings: [], transfers: new Set() };
      const imported = found.scope.module.imports.get(node.text);
      if (imported?.owner === found.node) {
        const module = resolveModule(found.scope.module, imported.module);
        if (!module) return { kind: "opaque", bindings: [], transfers: new Set() };
        const exported = module.exports.get(imported.name);
        return exported
          ? arrayReceiverSource({ node: exported, context: { module } }, depth + 1)
          : unknownReceiver();
      }
      const binding = found.node;
      if (!ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name))
        return unknownReceiver();
      const context = contextAt(found.scope, value.context);
      if (!context) return unknownReceiver();
      const assignments = (bindingAssignments.get(binding) ?? []).filter(
        (assignment) => assignment.name === node.text,
      );
      const sources = [
        ...(binding.initializer ? [binding.initializer] : []),
        ...assignments.map((assignment) => assignment.value),
      ];
      if (sources.length !== 1) return unknownReceiver();
      const result = arrayReceiverSource({ node: sources[0], context }, depth + 1);
      return { ...result, bindings: [binding, ...result.bindings] };
    }
    if (ts.isObjectLiteralExpression(node))
      return {
        kind: "source",
        value: { node, context: value.context },
        bindings: [],
        transfers: new Set(),
      };
    if (ts.isAwaitExpression(node))
      return arrayReceiverSource({ node: node.expression, context: value.context }, depth + 1);
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const factory = arrayFactorySource({ node, context: value.context }, depth + 1);
      if (factory.kind === "opaque") return { kind: "opaque", bindings: [], transfers: new Set() };
      if (factory.kind !== "source") return unknownReceiver();
      const { node: fn, context: enclosing } = factory.value;
      const context = arrayFactoryContext(fn, enclosing, node, value.context);
      if (!context || !fn.body) return unknownReceiver();
      const values: ts.Node[] = [];
      if (ts.isBlock(fn.body))
        walkBody(
          fn.body,
          (child) => {
            if (ts.isReturnStatement(child)) values.push(child.expression ?? child);
          },
          consume,
        );
      else values.push(fn.body);
      if (values.length !== 1) return unknownReceiver();
      const result = arrayReceiverSource({ node: values[0], context }, depth + 1);
      result.transfers.add(unwrap(values[0]));
      return result;
    }
    return unknownReceiver();
  };
  const arrayReceiverMethodStable = (
    binding: ts.VariableDeclaration,
    key: string | undefined,
    opaque: boolean,
    transfers: ReadonlySet<ts.Node>,
    seen = new Set<ts.Node>(),
    depth = 0,
  ): boolean => {
    consume();
    if (depth > 12 || !ts.isIdentifier(binding.name)) return false;
    if (seen.has(binding)) return true;
    seen.add(binding);
    for (const identifier of bindingUses.get(binding) ?? []) {
      consume();
      if (identifier.text !== binding.name.text || identifier === binding.name) continue;
      let use: ts.Node = identifier;
      while (
        use.parent &&
        (ts.isParenthesizedExpression(use.parent) ||
          ts.isAsExpression(use.parent) ||
          ts.isTypeAssertionExpression(use.parent) ||
          ts.isSatisfiesExpression(use.parent))
      )
        use = use.parent;
      if (transfers.has(unwrap(use))) continue;
      const parent = use.parent;
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === use &&
        arrayReceiverMethodStable(parent, key, opaque, transfers, seen, depth + 1)
      )
        continue;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = unwrap(parent.left);
        const targetBinding = ts.isIdentifier(target) ? bindingAt(target)?.node : undefined;
        if (
          parent.right === use &&
          targetBinding &&
          ts.isVariableDeclaration(targetBinding) &&
          arrayReceiverMethodStable(targetBinding, key, opaque, transfers, seen, depth + 1)
        )
          continue;
        if (
          parent.left === use &&
          !binding.initializer &&
          (bindingAssignments.get(binding) ?? []).length === 1
        )
          continue;
      }
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === use
      ) {
        const member = ts.isPropertyAccessExpression(parent)
          ? parent.name.text
          : nativeElementKey(parent.argumentExpression);
        if (member === undefined) return false;
        if (key === undefined || member === key) {
          if (
            (ts.isCallExpression(parent.parent) || ts.isNewExpression(parent.parent)) &&
            parent.parent.expression === parent
          )
            continue;
          return false;
        }
        // Another local method could replace the selected method through this.
        if (
          !opaque &&
          (ts.isCallExpression(parent.parent) || ts.isNewExpression(parent.parent)) &&
          parent.parent.expression === parent
        )
          return false;
        continue;
      }
      if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken)
        continue;
      if (ts.isConditionalExpression(parent) && parent.condition === use) continue;
      if (ts.isIfStatement(parent) && parent.expression === use) continue;
      if (
        ts.isBinaryExpression(parent) &&
        ([
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(parent.operatorToken.kind) ||
          (parent.left === use &&
            parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken))
      )
        continue;
      if (ts.isExportAssignment(parent) || ts.isExportSpecifier(parent)) continue;
      return false;
    }
    return true;
  };
  const arrayFactoryContext = (
    fn: Fn,
    enclosing: Context,
    call: ts.CallExpression | ts.NewExpression,
    caller: Context,
  ): Context | undefined => {
    let use: ts.Node = call;
    while (
      use.parent &&
      (ts.isParenthesizedExpression(use.parent) ||
        ts.isAsExpression(use.parent) ||
        ts.isTypeAssertionExpression(use.parent) ||
        ts.isSatisfiesExpression(use.parent))
    )
      use = use.parent;
    const awaited = ts.isAwaitExpression(use.parent) && use.parent.expression === use;
    if (
      !fn.body ||
      ("asteriskToken" in fn && !!fn.asteriskToken) ||
      (fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
        (ts.isNewExpression(call) || !awaited))
    )
      return undefined;
    const args = new Map<string, Value | null>();
    const context: Context = { module: enclosing.module, fn, args, parent: enclosing };
    fn.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) return;
      const actual = call.arguments?.[index];
      const unwrapped = actual && unwrap(actual);
      const missing =
        !actual ||
        (unwrapped &&
          ts.isIdentifier(unwrapped) &&
          unwrapped.text === "undefined" &&
          !bindingAt(unwrapped));
      args.set(
        parameter.name.text,
        missing
          ? parameter.initializer
            ? { node: parameter.initializer, context }
            : null
          : { node: actual, context: caller },
      );
    });
    return context;
  };
  type ArrayFactorySource =
    | { kind: "source"; value: Value & { node: Fn } }
    | { kind: "opaque" | "unknown" };
  // Direct array producers and methods returning another receiver share one
  // classifier. An unresolved local call must never become an external query.
  const arrayFactorySource = (value: Value, depth = 0): ArrayFactorySource => {
    consume();
    if (depth > 12) return { kind: "unknown" };
    const call = unwrap(value.node);
    if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return { kind: "unknown" };
    const expression = unwrap(call.expression);
    let callee = reference({ node: expression, context: value.context });
    const method =
      ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression);
    if (method) {
      const key = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : nativeElementKey(expression.argumentExpression);
      const receiver = arrayReceiverSource(
        { node: expression.expression, context: value.context },
        depth + 1,
      );
      if (
        receiver.kind === "unknown" ||
        !receiver.bindings.every((binding) =>
          arrayReceiverMethodStable(binding, key, receiver.kind === "opaque", receiver.transfers),
        )
      )
        return { kind: "unknown" };
      if (receiver.kind === "opaque") return { kind: "opaque" };
      const source = receiver.value;
      if (
        !source ||
        !ts.isObjectLiteralExpression(source.node) ||
        key === undefined ||
        source.node.properties.some(
          (property) =>
            ts.isSpreadAssignment(property) ||
            ts.isGetAccessorDeclaration(property) ||
            ts.isSetAccessorDeclaration(property),
        )
      )
        return { kind: "unknown" };
      const properties = source.node.properties.filter(
        (property) =>
          nativeSelectionKey(property.name) === undefined ||
          nativeSelectionKey(property.name) === key,
      );
      if (properties.length !== 1) return { kind: "unknown" };
      const property = properties[0];
      if (ts.isMethodDeclaration(property)) callee = { node: property, context: source.context };
      else if (ts.isPropertyAssignment(property))
        callee = reference({ node: property.initializer, context: source.context });
      else if (ts.isShorthandPropertyAssignment(property))
        callee = reference({ node: property.name, context: source.context });
      else return { kind: "unknown" };
      if (!callee) return { kind: "unknown" };
    }
    for (let count = 0; callee && ts.isVariableDeclaration(callee.node); count++) {
      consume();
      if (count > 12 || !isConst(callee.node) || !callee.node.initializer)
        return { kind: "unknown" };
      callee = reference({ node: callee.node.initializer, context: callee.context });
    }
    if (!callee || !isFn(callee.node)) {
      if (ts.isIdentifier(expression)) {
        const found = bindingAt(expression);
        if (!found?.node)
          return { kind: intrinsicFactoryRoots.has(expression.text) ? "unknown" : "opaque" };
        const imported = found.scope.module.imports.get(expression.text);
        if (imported?.owner === found.node && !resolveModule(found.scope.module, imported.module))
          return { kind: "opaque" };
      }
      return { kind: "unknown" };
    }
    const fn = callee.node;
    // Only ordinary functions can supply a supported explicit constructor
    // return. Class instances, arrows and methods are not reclassified as queries.
    if (ts.isNewExpression(call) && !ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn))
      return { kind: "unknown" };
    if (method || ts.isNewExpression(call)) {
      if (!fn.body) return { kind: "unknown" };
      const pending: ts.Node[] = [fn.body];
      while (pending.length) {
        consume();
        const node = pending.pop()!;
        if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword)
          return { kind: "unknown" };
        if (!ts.isTypeNode(node))
          ts.forEachChild(node, (child) => {
            pending.push(child);
          });
      }
    }
    return { kind: "source", value: { node: fn, context: callee.context } };
  };
  const arrayCallProducerIsLocal = (
    value: Value,
    operation: ts.CallExpression,
    _seen: Map<ts.Node, Set<string>>,
    depth: number,
    returnedValues: ReadonlySet<ts.Node>,
    selectedKey?: string,
  ): boolean => {
    consume();
    if (depth > 12) return false;
    const call = unwrap(value.node);
    if (!ts.isCallExpression(call)) return false;
    const factory = arrayFactorySource({ node: call, context: value.context }, depth + 1);
    if (factory.kind !== "source") return factory.kind === "opaque";
    const { node: fn, context: enclosing } = factory.value;
    const context = arrayFactoryContext(fn, enclosing, call, value.context);
    if (!context || !fn.body) return false;
    const values: Value[] = [];
    if (ts.isBlock(fn.body)) {
      walkBody(
        fn.body,
        (node) => {
          if (ts.isReturnStatement(node)) {
            if (node.expression) values.push({ node: node.expression, context });
            else values.push({ node, context });
          }
        },
        consume,
      );
    } else values.push({ node: fn.body, context });
    if (!values.length || values.length > 32) return false;
    const returned = new Set(returnedValues);
    const allowReturnedLeaves = (node: ts.Node, level = 0): void => {
      consume();
      if (level > 12) throw new PageMapAnalysisValidationError();
      node = unwrap(node);
      returned.add(node);
      if (ts.isConditionalExpression(node)) {
        allowReturnedLeaves(node.whenTrue, level + 1);
        allowReturnedLeaves(node.whenFalse, level + 1);
      }
    };
    const selected: Value[] = [];
    for (const result of values) {
      const items = selectedKey === undefined ? [result] : objectProperty(result, selectedKey);
      if (!items?.length) return false;
      selected.push(...items);
      for (const item of items) allowReturnedLeaves(item.node);
    }
    // A local alias belongs to this invocation. A previous call's success must
    // never certify another call with different actual arguments.
    const invocationSeen = new Map<ts.Node, Set<string>>();
    return selected.every((result) =>
      arrayProducerIsLocal(result, operation, invocationSeen, depth + 1, returned),
    );
  };
  const declaredArray = (value: Value, operation: ts.CallExpression, depth = 0): boolean => {
    consume();
    if (depth > 12 || !nativeArrays) return false;
    const node = unwrap(value.node);
    if (ts.isArrayLiteralExpression(node)) return true;
    if (ts.isIdentifier(node)) {
      const binding = bindingAt(node)?.node;
      if (binding && (ts.isVariableDeclaration(binding) || ts.isParameter(binding))) {
        if (!arrayProducerIsLocal(value, operation)) return false;
        if (ts.isVariableDeclaration(binding) && binding.initializer) {
          const initializer = unwrap(binding.initializer);
          if (ts.isObjectLiteralExpression(initializer) || ts.isClassExpression(initializer))
            return false;
          // An annotation cannot override an observable custom producer.
          if (
            ts.isCallExpression(initializer) &&
            ts.isPropertyAccessExpression(initializer.expression) &&
            ["split", "filter"].includes(initializer.expression.name.text)
          )
            return declaredArray(
              { node: initializer, context: value.context },
              operation,
              depth + 1,
            );
        }
        if (
          binding.type &&
          (ts.isArrayTypeNode(binding.type) ||
            (ts.isTypeReferenceNode(binding.type) &&
              ts.isIdentifier(binding.type.typeName) &&
              ["Array", "ReadonlyArray"].includes(binding.type.typeName.text)))
        )
          return true;
        return (
          ts.isVariableDeclaration(binding) &&
          !written.has(binding) &&
          !!binding.initializer &&
          declaredArray({ node: binding.initializer, context: value.context }, operation, depth + 1)
        );
      }
      return false;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === "split") return supportedNativeSplit(node, value.context);
      if (node.expression.name.text === "filter")
        return (
          supportedNativeFilter(node) &&
          declaredArray(
            { node: node.expression.expression, context: value.context },
            node,
            depth + 1,
          )
        );
    }
    return false;
  };
  // Only a stable producer may also certify a map element's primitive type.
  // This is not a value substitution and does not make the element HTML-safe.
  const localArrayLineage = (
    binding: ts.VariableDeclaration,
    mapCall: ts.CallExpression,
  ): boolean =>
    isConst(binding) &&
    !!binding.initializer &&
    !written.has(binding) &&
    arrayUsesStayLocal(binding, mapCall);
  const nativeStringElements = (value: Value, mapCall: ts.CallExpression, depth = 0): boolean => {
    consume();
    if (depth > 12 || !nativeStrings || !nativeArrays) return false;
    const resolved = reference(value);
    if (!resolved) return false;
    const { node, context } = resolved;
    if (ts.isVariableDeclaration(node))
      return (
        localArrayLineage(node, mapCall) &&
        !!node.initializer &&
        nativeStringElements({ node: node.initializer, context }, mapCall, depth + 1)
      );
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
    if (node.expression.name.text === "split") return supportedNativeSplit(node, context);
    if (node.expression.name.text === "filter")
      return (
        supportedNativeFilter(node) &&
        nativeStringElements({ node: node.expression.expression, context }, node, depth + 1)
      );
    return false;
  };
  const usesArrayCallbackArgument = (fn: Fn): boolean => {
    // Rest arguments beginning before slot three can expose map's whole-array argument.
    if (
      fn.parameters.some(
        (parameter, index) =>
          index < 3 &&
          !!parameter.dotDotDotToken &&
          (bindingUses.get(parameter) ?? []).some((use) => use !== parameter.name),
      )
    )
      return true;
    const parameter = fn.parameters[2];
    if (
      parameter &&
      (!ts.isIdentifier(parameter.name) ||
        (bindingUses.get(parameter) ?? []).some((use) => use !== parameter.name))
    )
      return true;
    // An ordinary callback owns arguments; arrows nested inside it capture that same object.
    if (ts.isArrowFunction(fn) || !fn.body) return false;
    const pending: ts.Node[] = [fn.body];
    while (pending.length) {
      consume();
      const node = pending.pop()!;
      if (ts.isTypeNode(node)) continue;
      if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) continue;
      if (ts.isIdentifier(node) && node.text === "arguments" && isValueIdentifier(node))
        return true;
      ts.forEachChild(node, (child) => {
        pending.push(child);
      });
    }
    return false;
  };
  const collectHtml = (value: Value, budget: { left: number }, depth = 0): Document[] => {
    consume();
    if (--budget.left < 0) throw new PageMapAnalysisValidationError();
    if (depth > 20) return unknown();
    const resolved = reference(value);
    if (!resolved) return unknown();
    const { node, context } = resolved;
    if (ts.isVariableDeclaration(node))
      return isConst(node) && ts.isIdentifier(node.name) && node.initializer
        ? collectHtml({ node: node.initializer, context }, budget, depth + 1)
        : unknown();
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const origin: Origin = {
        file: context.module.file,
        start: node.getStart(context.module.source),
        end: node.end,
      };
      if (ts.isStringLiteralLike(node))
        return [chargeDocument([{ text: node.text, origin, part: node.pos }])];
      let documents: Document[] = [
        chargeDocument([{ text: node.head.text, origin, part: node.head.pos }]),
      ];
      for (const span of node.templateSpans) {
        documents = combine(
          documents,
          collectHtml({ node: span.expression, context }, budget, depth + 1),
        );
        documents = combine(documents, [
          [{ text: span.literal.text, origin, part: span.literal.pos }],
        ]);
      }
      return documents;
    }
    if (ts.isConditionalExpression(node)) {
      const condition = literalValue({ node: node.condition, context });
      if (condition)
        return collectHtml(
          { node: condition.value ? node.whenTrue : node.whenFalse, context },
          budget,
          depth + 1,
        );
      return alternatives([
        ...collectHtml({ node: node.whenTrue, context }, budget, depth + 1),
        ...collectHtml({ node: node.whenFalse, context }, budget, depth + 1),
      ]);
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        node.operatorToken.kind,
      )
    ) {
      const left = literalValue({ node: node.left, context });
      if (left) {
        const useLeft =
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            ? left.value !== null && left.value !== undefined
            : !!left.value;
        return collectHtml({ node: useLeft ? node.left : node.right, context }, budget, depth + 1);
      }
      return alternatives([
        ...collectHtml({ node: node.left, context }, budget, depth + 1),
        ...collectHtml({ node: node.right, context }, budget, depth + 1),
      ]);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (
        method === "replace" &&
        node.arguments.length === 2 &&
        ts.isRegularExpressionLiteral(node.arguments[0]) &&
        ts.isStringLiteralLike(node.arguments[1])
      ) {
        const match = /^\/([&<>"'])\/g$/.exec(node.arguments[0].text);
        const replacement = node.arguments[1].text;
        if (!match || replacement.includes("$") || !primitiveString({ node: receiver, context }))
          return unknown();
        const character = match[1];
        return collectHtml({ node: receiver, context }, budget, depth + 1).map((document) =>
          chargeDocument(
            document.map((piece) => {
              if (!piece.unknown)
                return { ...piece, text: piece.text.split(character).join(replacement) };
              const excluded = [...new Set((piece.excluded ?? "") + character)]
                .filter((item) => !replacement.includes(item))
                .join("");
              return { text: UNKNOWN, unknown: true, excluded };
            }),
          ),
        );
      }
      if (
        method === "join" &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text === "" &&
        ts.isCallExpression(receiver) &&
        ts.isPropertyAccessExpression(receiver.expression) &&
        receiver.expression.name.text === "map" &&
        receiver.arguments.length === 1 &&
        declaredArray({ node: receiver.expression.expression, context }, receiver)
      ) {
        const callback = reference({ node: receiver.arguments[0], context });
        if (!callback || !isFn(callback.node)) return unknown();
        const documents = collectFunction(
          callback.node,
          callback.context,
          callback.node.parameters.map(() => null),
          budget,
          depth + 1,
          !usesArrayCallbackArgument(callback.node) &&
            nativeStringElements({ node: receiver.expression.expression, context }, receiver),
        );
        return documents.every((document) => repeatableFragment(document, consume))
          ? documents
          : unknown();
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return combine(
        collectHtml({ node: node.left, context }, budget, depth + 1),
        collectHtml({ node: node.right, context }, budget, depth + 1),
      );
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      let callee = reference({ node: node.expression, context });
      if (
        callee &&
        ts.isVariableDeclaration(callee.node) &&
        isConst(callee.node) &&
        callee.node.initializer
      ) {
        callee = { node: unwrap(callee.node.initializer), context: callee.context };
      }
      if (!callee || !isFn(callee.node)) return unknown();
      return collectFunction(
        callee.node,
        callee.context,
        node.arguments.map((argument) => ({ node: argument, context })),
        budget,
        depth,
      );
    }
    return unknown();
  };
  const isHtmlType = (node: ts.Node | undefined) =>
    !!node && ts.isStringLiteralLike(node) && /^(?:html|text\/html)(?:\s*;.*)?$/i.test(node.text);
  const hasBodyStatus = (node: ts.Node | undefined) => {
    if (!node || !ts.isNumericLiteral(node)) return false;
    const status = Number(node.text);
    return (
      Number.isInteger(status) &&
      status >= 200 &&
      status <= 599 &&
      ![204, 205, 304].includes(status)
    );
  };
  const member = (node: ts.Node) => {
    node = unwrap(node);
    if (ts.isPropertyAccessExpression(node))
      return { receiver: node.expression, name: node.name.text };
    if (ts.isElementAccessExpression(node))
      return {
        receiver: node.expression,
        name: ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined,
      };
    return undefined;
  };
  const responseRoot = (node: ts.Node, response: ts.ParameterDeclaration) => {
    let current = unwrap(node);
    for (let depth = 0; depth < 16 && ts.isCallExpression(current); depth++) {
      const access = member(current.expression);
      if (!access) break;
      current = unwrap(access.receiver);
    }
    return ts.isIdentifier(current) && bindingAt(current)?.node === response;
  };
  const responseIsAmbiguous = (fn: Fn, response: ts.ParameterDeclaration) => {
    let ambiguous = false;
    if (!fn.body) return true;
    const scanned = new Set<Fn>();
    const captures = (root: ts.Node): boolean => {
      const pending = [root];
      while (pending.length) {
        consume();
        const node = pending.pop()!;
        if (ts.isIdentifier(node) && bindingAt(node)?.node === response) return true;
        if (!ts.isTypeNode(node))
          ts.forEachChild(node, (child) => {
            pending.push(child);
          });
      }
      return false;
    };
    const constructionCaptures = (root: ts.Node, seen = new Set<ts.Node>(), depth = 0): boolean => {
      consume();
      if (depth > 16) return true;
      if (seen.has(root)) return false;
      seen.add(root);
      const pending = [root];
      while (pending.length) {
        consume();
        const node = pending.pop()!;
        if (ts.isTypeNode(node)) continue;
        if (ts.isIdentifier(node)) {
          const binding = bindingAt(node)?.node;
          if (binding === response) return true;
          // Follow local constructor aliases and factories, without executing them.
          if (
            binding &&
            (isFn(binding) ||
              ts.isClassDeclaration(binding) ||
              (ts.isVariableDeclaration(binding) && isConst(binding))) &&
            constructionCaptures(binding, seen, depth + 1)
          )
            return true;
        }
        ts.forEachChild(node, (child) => {
          pending.push(child);
        });
      }
      return false;
    };
    const scan = (current: Fn, context: Context, depth = 0): void => {
      if (!current.body) return;
      if (depth > 16 || scanned.has(current)) {
        ambiguous = true;
        return;
      }
      scanned.add(current);
      walkBody(
        current.body,
        (node) => {
          if (
            ts.isIdentifier(node) &&
            bindingAt(node)?.node === response &&
            !(ts.isParameter(node.parent) && node.parent.name === node)
          ) {
            let expression: ts.Node = node;
            while (
              ts.isParenthesizedExpression(expression.parent) ||
              ts.isAsExpression(expression.parent)
            )
              expression = expression.parent;
            const access = member(expression.parent);
            if (!access || access.receiver !== expression) ambiguous = true;
          }
          if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
            node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ) {
            const access = member(node.left);
            if (
              access &&
              responseRoot(access.receiver, response) &&
              (access.name !== "statusCode" ||
                node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                !hasBodyStatus(node.right))
            )
              ambiguous = true;
          }
          if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
            const access = member(node.operand);
            if (
              access &&
              responseRoot(access.receiver, response) &&
              [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
            )
              ambiguous = true;
          }
          if (ts.isNewExpression(node)) {
            if (
              constructionCaptures(node.expression) ||
              node.arguments?.some((argument) => constructionCaptures(argument))
            )
              ambiguous = true;
            return;
          }
          if (!ts.isCallExpression(node)) return;
          const access = member(node.expression);
          if (!access || !responseRoot(access.receiver, response)) {
            let callee = reference({ node: node.expression, context });
            if (
              callee &&
              ts.isVariableDeclaration(callee.node) &&
              isConst(callee.node) &&
              callee.node.initializer
            )
              callee = { node: unwrap(callee.node.initializer), context: callee.context };
            if (callee && isFn(callee.node) && captures(callee.node)) {
              if (
                callee.node.modifiers?.some(
                  (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                )
              )
                ambiguous = true;
              else
                scan(
                  callee.node,
                  { module: callee.context.module, fn: callee.node, parent: callee.context },
                  depth + 1,
                );
            } else if (access) {
              const owner = reference({ node: access.receiver, context });
              if (owner && captures(owner.node)) ambiguous = true;
            }
            for (const argument of node.arguments) {
              const callback = reference({ node: argument, context });
              if (callback && captures(callback.node)) ambiguous = true;
            }
            return;
          }
          const method = access.name;
          if (method === "type" || method === "contentType") {
            if (!isHtmlType(node.arguments[0])) ambiguous = true;
          } else if (method === "status") {
            if (!hasBodyStatus(node.arguments[0])) ambiguous = true;
          } else if (method && ["set", "header", "setHeader"].includes(method)) {
            const name = node.arguments[0];
            if (!name || !ts.isStringLiteralLike(name)) ambiguous = true;
            else if (name.text.toLowerCase() === "content-type" && !isHtmlType(node.arguments[1]))
              ambiguous = true;
          } else if (!method || !["send", "json", "redirect", "sendStatus"].includes(method))
            ambiguous = true;
        },
        consume,
      );
      scanned.delete(current);
    };
    const module = nodeScopes.get(fn)?.module;
    if (!module) return true;
    scan(fn, { module, fn });
    return ambiguous;
  };
  const pages: ExpressPage[] = [];
  const seen = new Set<string>();
  const visited = new Map<Handle, Set<string>>();
  const handleIds = new Map([...handles.values()].map((handle, index) => [handle, index]));
  const visit = (handle: Handle, prefix: string, ancestry: Set<Handle>) => {
    consume();
    if (--mountVisits < 0) throw new PageMapAnalysisValidationError();
    if (ancestry.has(handle)) return;
    if (ancestry.size >= 16) throw new PageMapAnalysisValidationError();
    const traversalKey =
      canonicalRoute(prefix) +
      "\n" +
      [...ancestry]
        .map((ancestor) => handleIds.get(ancestor)!)
        .sort((a, b) => a - b)
        .join(",");
    const prior = visited.get(handle) ?? new Set<string>();
    if (prior.has(traversalKey)) return;
    prior.add(traversalKey);
    visited.set(handle, prior);
    const next = new Set(ancestry).add(handle);
    for (const entry of handle.routes) {
      consume();
      const documentPath = joinDocumentPath(prefix, entry.route);
      const route = canonicalRoute(documentPath);
      const key = entry.module.file.path + "\n" + documentPath + "\n" + entry.fn.pos;
      if (
        seen.has(key) ||
        !entry.fn.body ||
        !entry.fn.parameters[1] ||
        !ts.isIdentifier(entry.fn.parameters[1].name)
      )
        continue;
      const context: Context = { module: entry.module, fn: entry.fn };
      const response = entry.fn.parameters[1];
      if (responseIsAmbiguous(entry.fn, response)) continue;
      const documents: Document[] = [];
      const budget = { left: 2000 };
      walkBody(
        entry.fn.body,
        (node) => {
          if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            node.expression.name.text !== "send" ||
            node.arguments.length !== 1
          )
            return;
          let receiver: ts.Node = node.expression.expression;
          for (
            let depth = 0;
            depth < 8 &&
            ts.isCallExpression(receiver) &&
            ts.isPropertyAccessExpression(receiver.expression);
            depth++
          ) {
            const method = receiver.expression.name.text;
            if (
              !(
                (method === "status" && hasBodyStatus(receiver.arguments[0])) ||
                (["type", "contentType"].includes(method) && isHtmlType(receiver.arguments[0]))
              )
            )
              break;
            receiver = receiver.expression.expression;
          }
          if (!ts.isIdentifier(receiver) || bindingAt(receiver)?.node !== response) return;
          documents.push(...collectHtml({ node: node.arguments[0], context }, budget));
          if (documents.length > 256) throw new PageMapAnalysisValidationError();
        },
        consume,
      );
      const declarations = new Map<string, ExpressPage["links"][number]>();
      let hasPage = false;
      for (const document of documents) {
        const parsed = htmlDeclarations(document, consume);
        hasPage ||= parsed.hasPage;
        for (const link of parsed.links) {
          const prior = declarations.get(link.ordinal);
          if (!prior) declarations.set(link.ordinal, { ...link });
          else {
            if (prior.target !== link.target) delete prior.target;
            prior.baseUnknown ||= link.baseUnknown;
            prior.parsingUnknown ||= link.parsingUnknown;
          }
        }
      }
      const links = [...declarations.values()];
      if (!hasPage) continue;
      if (pages.length >= 500) throw new PageMapAnalysisValidationError();
      seen.add(key);
      pages.push({ route, documentPath, filePath: entry.module.file.path, links });
    }
    for (const mount of handle.mounts)
      visit(mount.target, joinDocumentPath(prefix, mount.route), next);
  };
  for (const handle of handles.values()) if (handle.root) visit(handle, "/", new Set());
  return pages;
}
