/**
 * Reference graph for `ts_reachability.mjs` (see that file for the method and its limits).
 *
 * One pass over every own source file of a program:
 *   1. `register`: every tracked declaration gets a node — top-level function/var/class/interface/type/
 *      enum, every interface and type-literal member, every class member, every member of an
 *      un-annotated top-level object table (`const api = { … }`, nested tables too), and one `module`
 *      node per file (its top-level statements).
 *   2. `collect`: every identifier/property name is resolved with the checker and becomes an edge from
 *      the nearest enclosing tracked declaration (its "container") to what it names: `read`, `write`
 *      (object-literal key, JSX attribute, `x.p = …`), `dynamic` (`o[k]`, `for…in`, `k in o`: every
 *      member of the type is read) or `escape` (the value reaches `any`/`unknown`/`object`, an index
 *      signature or a library type: every member, recursively, is read).
 *   3. Structural flow (`ts_reach_flow.mjs`): wherever a value moves from type S to type T (contextual
 *      types of initializers, arguments, returns, JSX attributes, array elements, spreads, `as`/
 *      `satisfies`, both sides of `??`/`||`/`?:`, call signatures, `implements`/`extends`, element types
 *      of Array/Promise/…), a gated edge "if T.p is read, S.p is read" is recorded.
 * Resolving every identifier once with the checker is what `LanguageService.findReferences` does per
 * declaration, done for all declarations in one O(files) walk; the CLI's `--evidence` re-checks every
 * finding with the real `findReferences`.
 */
import { resolve } from 'node:path'
import { posixRel } from './audit_common.mjs'
import { createFlow } from './ts_reach_flow.mjs'

const NAME_KINDS = [
  'VariableDeclaration', 'FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression',
  'InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration', 'EnumMember', 'Parameter', 'PropertyDeclaration',
  'PropertySignature', 'MethodDeclaration', 'MethodSignature', 'GetAccessor', 'SetAccessor', 'PropertyAssignment',
  'BindingElement', 'TypeParameter', 'ModuleDeclaration', 'ImportSpecifier', 'ExportSpecifier', 'ImportClause',
  'NamespaceImport', 'NamespaceExport', 'ImportEqualsDeclaration', 'JsxAttribute', 'LabeledStatement',
  'BreakStatement', 'ContinueStatement', 'ShorthandPropertyAssignment', 'NamedTupleMember',
]

/** Strip `as const`, `satisfies T`, parentheses: the object literal a table is written as. */
export function unwrapTable(ts, node) {
  let n = node
  while (n && (ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n)
    || (ts.isAsExpression(n) && ts.isTypeReferenceNode(n.type) && n.type.typeName.getText() === 'const'))) n = n.expression
  return n && ts.isObjectLiteralExpression(n) ? n : undefined
}

function memberName(ts, name) {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

export class Graph {
  constructor(ts, program, def, sourceFiles) {
    this.ts = ts
    this.program = program
    this.checker = program.getTypeChecker()
    this.def = def
    this.sourceFiles = sourceFiles
    this.own = new Set(sourceFiles)
    this.nodes = []
    this.declId = new Map() // declaration node → id
    this.moduleId = new Map() // SourceFile → id
    this.read = new Map() // container → Set<id>
    this.write = new Map()
    this.flows = new Map() // container → [[fromIds, toIds]]
    this.refs = new Map() // id → {prod, test, write}
    this.nameKinds = new Set(NAME_KINDS.map((k) => ts.SyntaxKind[k]))
    this.flow = createFlow(this)
  }

  // ── nodes ───────────────────────────────────────────────────────────

  addNode(info) {
    const id = this.nodes.length
    this.nodes.push({ id, ...info })
    return id
  }

  relOf(sf) {
    return posixRel(this.def.base, resolve(sf.fileName))
  }

  isOwnDecl(decl) {
    return this.own.has(decl.getSourceFile())
  }

  /** Tracked ids of a symbol's declarations (aliases resolved). */
  idsOf(symbol) {
    if (!symbol) return []
    let sym = symbol
    if (sym.flags & this.ts.SymbolFlags.Alias) {
      try { sym = this.checker.getAliasedSymbol(sym) } catch { return [] }
    }
    const out = []
    for (const decl of sym.declarations ?? []) {
      const id = this.declId.get(decl)
      if (id !== undefined) out.push(id)
    }
    return out
  }

  register(node, name, kind, parent, extra = {}) {
    const sf = node.getSourceFile()
    const rel = this.relOf(sf)
    const parentNode = parent === undefined ? undefined : this.nodes[parent]
    const qualified = parentNode && parentNode.kind !== 'module' ? `${parentNode.qualified}.${name}` : name
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
    const id = this.addNode({
      kind, name, qualified, rel, line, parent, sf, node,
      isTest: this.def.isTestFile(rel),
      key: `${this.def.name}:${rel}#${qualified}`,
      ...extra,
    })
    this.declId.set(node, id)
    return id
  }

  /** Is this interface merged with a library declaration (ImportMetaEnv, Window, …)? Platform-facing. */
  mergesWithLibrary(node) {
    const sym = node.name && this.checker.getSymbolAtLocation(node.name)
    return Boolean(sym?.declarations?.some((d) => !this.isOwnDecl(d)))
  }

  registerTypeMembers(members, parent) {
    const ts = this.ts
    for (const m of members) {
      const name = memberName(ts, m.name)
      if (name === undefined || !(ts.isPropertySignature(m) || ts.isMethodSignature(m))) continue
      this.register(m, name, 'member', parent, { member: 'type' })
    }
  }

  registerTable(objLit, parent) {
    const ts = this.ts
    for (const p of objLit.properties) {
      const name = memberName(ts, p.name)
      if (name === undefined) continue
      if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)
        || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))) continue
      const id = this.register(p, name, 'member', parent, { member: 'table' })
      const nested = ts.isPropertyAssignment(p) ? unwrapTable(ts, p.initializer) : undefined
      if (nested) this.registerTable(nested, id)
    }
  }

  registerClass(node, parent) {
    const ts = this.ts
    const name = node.name?.text ?? 'default'
    const id = this.register(node, name, parent === undefined ? 'class' : 'local', parent, { runtime: true })
    for (const m of node.members) {
      if (ts.isConstructorDeclaration(m)) {
        for (const p of m.parameters) {
          if (ts.getModifiers(p)?.length && ts.isIdentifier(p.name)) this.register(p, p.name.text, 'member', id, { member: 'class' })
        }
        continue
      }
      const mname = memberName(ts, m.name)
      if (mname === undefined || ts.isIndexSignatureDeclaration(m) || ts.isClassStaticBlockDeclaration(m)) continue
      const isStatic = Boolean(ts.getModifiers(m)?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword))
      this.register(m, mname, 'member', id, { member: 'class', isStatic })
    }
    return id
  }

  registerFile(sf) {
    const ts = this.ts
    const moduleNode = this.register(sf, '<module>', 'module', undefined)
    this.moduleId.set(sf, moduleNode)
    const visitNested = (node, owner) => {
      // Interfaces, type literals and classes anywhere (inside functions too) get their members tracked.
      let nextOwner = owner
      const known = this.declId.get(node)
      if (known !== undefined && node !== sf) nextOwner = known
      else if (ts.isInterfaceDeclaration(node) && !this.mergesWithLibrary(node)) {
        nextOwner = this.register(node, node.name.text, 'local', owner)
        this.registerTypeMembers(node.members, nextOwner)
      } else if (ts.isSatisfiesExpression(node)) {
        // `satisfies {…}` is a constraint pattern, not a type anything is read through.
        visitNested(node.expression, nextOwner)
        return
      } else if (ts.isTypeLiteralNode(node)) {
        this.registerTypeMembers(node.members, owner)
      } else if (ts.isClassDeclaration(node) && owner !== moduleNode) {
        nextOwner = this.registerClass(node, owner)
      } else if (ts.isModuleDeclaration(node)) {
        return // `declare global` / `declare module`: platform augmentation, not ours to judge
      }
      ts.forEachChild(node, (child) => visitNested(child, nextOwner))
    }
    for (const st of sf.statements) this.registerTop(st, moduleNode)
    ts.forEachChild(sf, (child) => visitNested(child, moduleNode))
  }

  registerTop(st, moduleNode) {
    const ts = this.ts
    if (ts.isFunctionDeclaration(st)) {
      const name = st.name?.text ?? 'default'
      this.register(st, name, 'function', moduleNode, { runtime: true })
    } else if (ts.isClassDeclaration(st)) {
      this.registerClass(st, moduleNode)
    } else if (ts.isInterfaceDeclaration(st)) {
      if (this.mergesWithLibrary(st)) return
      const id = this.register(st, st.name.text, 'type', moduleNode)
      this.registerTypeMembers(st.members, id)
    } else if (ts.isTypeAliasDeclaration(st)) {
      this.register(st, st.name.text, 'type', moduleNode)
    } else if (ts.isEnumDeclaration(st)) {
      this.register(st, st.name.text, 'enum', moduleNode, { runtime: true })
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          const id = this.register(d, d.name.text, 'var', moduleNode, { runtime: true })
          const table = !d.type ? unwrapTable(ts, d.initializer) : undefined
          if (table) this.registerTable(table, id)
        } else {
          for (const el of d.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) this.register(el, el.name.text, 'var', moduleNode, { runtime: true })
          }
        }
      }
    }
  }

  // ── edges ───────────────────────────────────────────────────────────

  edge(map, container, id) {
    let set = map.get(container)
    if (!set) map.set(container, (set = new Set()))
    set.add(id)
  }

  count(id, container, field) {
    const fromTest = this.nodes[container].isTest
    let c = this.refs.get(id)
    if (!c) this.refs.set(id, (c = { prod: 0, test: 0, write: 0 }))
    if (field === 'write') c.write += 1
    else if (fromTest) c.test += 1
    else c.prod += 1
  }

  addRead(container, ids) {
    for (const id of ids) {
      if (id === container) continue
      this.edge(this.read, container, id)
      this.count(id, container, 'read')
    }
  }

  addWrite(container, ids) {
    for (const id of ids) {
      this.edge(this.write, container, id)
      this.count(id, container, 'write')
    }
  }

  addFlow(container, fromIds, toIds) {
    const to = toIds.filter((id) => !fromIds.includes(id))
    if (!fromIds.length || !to.length) return
    let list = this.flows.get(container)
    if (!list) this.flows.set(container, (list = []))
    list.push([fromIds, to])
  }

  /** Tracked ids of the properties named `name` on a type (every union constituent). */
  propIds(type, name) {
    return this.flow.propSymbols(type, name).flatMap((s) => this.idsOf(s))
  }

  /** Every tracked member of a type (one level): the target of a dynamic read. */
  allPropIds(type) {
    const out = []
    for (const t of this.flow.constituents(type)) {
      for (const p of this.checker.getPropertiesOfType(t)) out.push(...this.idsOf(p))
    }
    return out
  }

  collectAll() {
    for (const sf of this.sourceFiles) this.registerFile(sf)
    for (const sf of this.sourceFiles) this.collectFile(sf)
  }

  collectFile(sf) {
    const ts = this.ts
    const moduleNode = this.moduleId.get(sf)
    // A tracked top-level declaration is executed by loading its module.
    for (const st of sf.statements) {
      const ids = ts.isVariableStatement(st)
        ? st.declarationList.declarations.flatMap((d) => [this.declId.get(d), ...(ts.isIdentifier(d.name) ? [] : d.name.elements.map((e) => this.declId.get(e)))])
        : [this.declId.get(st)]
      for (const id of ids) if (id !== undefined) this.edge(this.read, id, moduleNode)
      this.collectImport(st, moduleNode)
    }
    const visit = (node, container) => {
      const own = this.declId.get(node)
      const c = own !== undefined && node !== sf ? own : container
      this.visitNode(node, c)
      ts.forEachChild(node, (child) => visit(child, c))
    }
    visit(sf, moduleNode)
  }

  collectImport(st, moduleNode) {
    const ts = this.ts
    const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) ? st.moduleSpecifier : undefined
    if (!spec || !ts.isStringLiteral(spec)) return
    if (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly) return
    if (ts.isExportDeclaration(st) && st.isTypeOnly) return
    const target = this.moduleOf(spec)
    if (target !== undefined) this.edge(this.read, moduleNode, target)
  }

  moduleOf(specifier) {
    const sym = this.checker.getSymbolAtLocation(specifier)
    const sf = sym?.valueDeclaration
    return sf && this.ts.isSourceFile(sf) ? this.moduleId.get(sf) : undefined
  }

  /** `import('x')`: the module runs and every export of it escapes (React.lazy pages, handlers). */
  dynamicImport(call, container) {
    const arg = call.arguments[0]
    if (!arg || !this.ts.isStringLiteralLike(arg)) return
    const sym = this.checker.getSymbolAtLocation(arg)
    if (!sym) return
    const target = this.moduleOf(arg)
    if (target !== undefined) this.edge(this.read, container, target)
    for (const exp of this.checker.getExportsOfModule(sym)) this.addRead(container, this.idsOf(exp))
  }

  visitNode(node, container) {
    const ts = this.ts
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) this.visitName(node, container)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) this.dynamicImport(node, container)
    else if (ts.isElementAccessExpression(node)) this.visitElementAccess(node, container)
    else if (ts.isBindingElement(node)) this.visitBinding(node, container)
    else if (ts.isObjectLiteralExpression(node)) this.visitObjectLiteral(node, container)
    else if (ts.isJsxAttributes(node)) this.visitJsxAttributes(node, container)
    else if (ts.isForInStatement(node)) this.addRead(container, this.allPropIds(this.checker.getTypeAtLocation(node.expression)))
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) this.visitIn(node, container)
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) this.flow.heritage(node, container)
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) this.flow.assertion(node, container)
    this.flow.slot(node, container)
  }

  isDeclName(id) {
    const p = id.parent
    return this.nameKinds.has(p.kind) && p.name === id
  }

  visitName(id, container) {
    const ts = this.ts
    const p = id.parent
    if (ts.isShorthandPropertyAssignment(p) && p.name === id) {
      this.addRead(container, this.idsOf(this.checker.getShorthandAssignmentValueSymbol(p)))
      return // the property side is handled with the object literal
    }
    if (this.isDeclName(id) || (ts.isBindingElement(p) && p.propertyName === id)) return
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return
    if (ts.isJsxAttribute(p)) return // JsxAttributes handles it (a write)
    if (ts.isExportAssignment(p)) return // `export default X`: reached through the importer's alias
    const sym = this.checker.getSymbolAtLocation(id)
    const ids = this.idsOf(sym)
    if (!ids.length) return
    if (ts.isPartOfTypeNode(id)) {
      // A type reference keeps a declaration alive; naming a member in a type (`T['k']`) is not a read.
      this.addRead(container, ids.filter((i) => this.nodes[i].kind !== 'member'))
      return
    }
    const expr = ts.isPropertyAccessExpression(p) && p.name === id ? p : id
    const kind = this.accessKind(expr)
    if (kind !== 'read') this.addWrite(container, ids)
    if (kind !== 'write') this.addRead(container, ids)
  }

  accessKind(expr) {
    const ts = this.ts
    let e = expr
    while (ts.isParenthesizedExpression(e.parent) || ts.isNonNullExpression(e.parent)) e = e.parent
    const p = e.parent
    if (ts.isBinaryExpression(p) && p.left === e) {
      const op = p.operatorToken.kind
      if (op === ts.SyntaxKind.EqualsToken) return 'write'
      if (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment) return 'readwrite'
    }
    if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p))
      && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return 'readwrite'
    if (ts.isDeleteExpression(p)) return 'write'
    return 'read'
  }

  visitElementAccess(node, container) {
    const ts = this.ts
    const arg = node.argumentExpression
    const type = this.checker.getTypeAtLocation(node.expression)
    if (ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg)) {
      const ids = this.propIds(type, arg.text)
      const kind = this.accessKind(node)
      if (kind !== 'read') this.addWrite(container, ids)
      if (kind !== 'write') this.addRead(container, ids)
    } else if (this.accessKind(node) !== 'write') {
      this.addRead(container, this.allPropIds(type))
    }
  }

  visitIn(node, container) {
    const type = this.checker.getTypeAtLocation(node.right)
    const left = node.left
    if (this.ts.isStringLiteralLike(left)) this.addRead(container, this.propIds(type, left.text))
    else this.addRead(container, this.allPropIds(type))
  }

  visitBinding(el, container) {
    const ts = this.ts
    const pattern = el.parent
    if (!ts.isObjectBindingPattern(pattern)) return
    const type = this.checker.getTypeAtLocation(pattern)
    if (el.dotDotDotToken) {
      this.addRead(container, this.allPropIds(type))
      return
    }
    const nameNode = el.propertyName ?? el.name
    const name = memberName(ts, nameNode)
    if (name !== undefined) this.addRead(container, this.propIds(type, name))
  }

  /** Object-literal keys write the contextual type's members (`return {isLoading}` → Result.isLoading). */
  visitObjectLiteral(lit, container) {
    const ts = this.ts
    const ctx = this.checker.getContextualType(lit)
    if (!ctx) return
    for (const p of lit.properties) {
      const name = memberName(ts, p.name)
      if (name === undefined) continue
      this.addWrite(container, this.propIds(ctx, name).filter((id) => this.nodes[id].node !== p))
    }
  }

  visitJsxAttributes(attrs, container) {
    const ts = this.ts
    const ctx = this.checker.getContextualType(attrs)
    if (!ctx) return
    for (const a of attrs.properties) {
      if (ts.isJsxAttribute(a)) {
        const name = ts.isIdentifier(a.name) ? a.name.text : undefined
        if (name) this.addWrite(container, this.propIds(ctx, name))
      } else if (ts.isJsxSpreadAttribute(a)) {
        this.flow.flowExpr(a.expression, ctx, container)
      }
    }
  }
}
