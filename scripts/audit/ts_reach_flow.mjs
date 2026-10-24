/**
 * Structural flow for `ts_reachability.mjs`: where a value of type S lands in a slot of type T, reading
 * `T.p` reads `S.p`. Recorded as a gated edge (container live AND T.p read ⇒ S.p read).
 *
 * Slots: contextual types (annotated initializers, parameter defaults, call/new arguments, returns,
 * arrow bodies, `=` right-hand sides, object-literal values and spreads, array elements, JSX attribute
 * values and spreads), `as`/`satisfies`/`<T>x`, and `implements`/`extends`. Through a slot the walk
 * follows both sides of `??`/`||`/`&&`/`?:`, then matches S against T member by member (union
 * constituents, call signatures — parameters flow T→S, returns S→T —, array/tuple elements, Promise
 * payloads, the type arguments of a shared generic target).
 *
 * Escapes (every member of S, recursively, counts as read): T is `any`/`unknown`/`object`, a type
 * parameter constrained to one of those, an index signature (`Record<string, X>`), or a library/
 * synthetic member (whoever holds the library value reads it: `JSON.stringify`, `fetch`, `console`).
 * An unconstrained type parameter is identity (`arr.push(x)`, `useState(x)`): the value comes back
 * typed as S and its reads resolve to S's members directly.
 */

export function createFlow(graph) {
  const { ts, checker } = graph
  const F = ts.TypeFlags
  const NO_MEMBERS = F.StringLike | F.NumberLike | F.BooleanLike | F.EnumLike | F.BigIntLike | F.ESSymbolLike
    | F.Null | F.Undefined | F.Void | F.Never
  const memo = new Set()
  const typeId = (t) => t.id ?? checker.typeToString(t)

  function constituents(type) {
    if (!type) return []
    const out = []
    for (const t of type.flags & F.Union ? type.types : [type]) {
      if (t.flags & F.TypeParameter) {
        const c = checker.getBaseConstraintOfType(t)
        if (c && c !== t) out.push(...constituents(c))
      } else out.push(t)
    }
    return out
  }

  function propSymbols(type, name) {
    const out = []
    for (const t of constituents(type)) {
      if (t.flags & NO_MEMBERS) continue
      const s = checker.getPropertyOfType(t, name)
      if (s) out.push(s)
    }
    return out
  }

  const allLibrary = (sym) => Boolean(sym?.declarations?.length) && sym.declarations.every((d) => !graph.isOwnDecl(d))

  /** A library object type without own members to track (Date, HTMLElement, …); mapped types are not. */
  function isLibraryShape(type) {
    if (type.flags & F.Intersection) return false
    if (type.objectFlags & ts.ObjectFlags.Mapped) return false
    if (type.aliasSymbol && !allLibrary(type.aliasSymbol)) return false
    return allLibrary(type.symbol)
  }

  const elementOf = (type) => checker.getIndexTypeOfType(type, ts.IndexKind.Number)
  const isArrayish = (type) => checker.isArrayType(type) || checker.isTupleType(type)

  function escapesTo(type) {
    if (type.flags & (F.Any | F.Unknown | F.NonPrimitive)) return true
    // `{}` and `Object`: anything goes in, nothing is known about what reads it.
    if (type.flags & F.Object && !checker.getPropertiesOfType(type).length && !type.getCallSignatures().length
      && !checker.getIndexInfosOfType(type).length && !isArrayish(type)) return true
    return false
  }

  /** Every member of `type`, recursively, is read from `container`. */
  function escape(type, container, depth = 0) {
    if (!type || depth > 6 || type.flags & NO_MEMBERS) return
    const key = `${container}|e|${typeId(type)}`
    if (memo.has(key)) return
    memo.add(key)
    if (type.flags & (F.Union | F.Intersection)) {
      for (const t of type.types) escape(t, container, depth)
      return
    }
    if (type.flags & F.TypeParameter) return
    if (isArrayish(type)) return escape(elementOf(type), container, depth + 1)
    for (const arg of type.target ? checker.getTypeArguments(type) : []) escape(arg, container, depth + 1)
    for (const sig of type.getCallSignatures()) escape(sig.getReturnType(), container, depth + 1)
    if (isLibraryShape(type)) return
    for (const p of checker.getPropertiesOfType(type)) {
      graph.addRead(container, graph.idsOf(p))
      escape(checker.getTypeOfSymbol(p), container, depth + 1)
    }
  }

  function flowSignatures(S, T, container, depth) {
    const sigS = S.getCallSignatures()
    const sigT = constituents(T).flatMap((t) => t.getCallSignatures())
    if (!sigS.length || !sigT.length) return false
    const s = sigS[0]
    const t = sigT[0]
    t.parameters.forEach((tp, i) => {
      const sp = s.parameters[i]
      if (sp) flowTypes(checker.getTypeOfSymbol(tp), checker.getTypeOfSymbol(sp), container, depth + 1)
    })
    flowTypes(s.getReturnType(), t.getReturnType(), container, depth + 1)
    return true
  }

  function flowMembers(S, T, container, depth, cast) {
    const index = constituents(T).map((t) => checker.getIndexInfoOfType(t, ts.IndexKind.String)).find(Boolean)
    for (const p of checker.getPropertiesOfType(S)) {
      const pIds = graph.idsOf(p)
      const targets = propSymbols(T, p.name).filter((tp) => tp !== p)
      if (!targets.length) {
        // An index signature reads every key; an `as` cast hands the extra member to a reader the
        // type system no longer sees (`{'--css-var': x} as CSSProperties`).
        if (index || (cast && !propSymbols(T, p.name).length)) graph.addRead(container, pIds)
        if (index) flowTypes(checker.getTypeOfSymbol(p), index.type, container, depth + 1)
        continue
      }
      for (const tp of targets) {
        const tIds = graph.idsOf(tp)
        if (tIds.length) graph.addFlow(container, tIds, pIds)
        else graph.addRead(container, pIds)
        flowTypes(checker.getTypeOfSymbol(p), checker.getTypeOfSymbol(tp), container, depth + 1)
      }
    }
  }

  /** A value of type S lands where T is expected, inside `container`. */
  function flowTypes(S, T0, container, depth = 0, cast = false) {
    if (!S || !T0 || S === T0 || depth > 6) return
    let T = T0
    if (T.flags & F.TypeParameter) {
      const c = checker.getBaseConstraintOfType(T)
      if (!c || c === T || c.flags & F.Unknown) return // identity: the value comes back typed as S
      T = c
    }
    if (escapesTo(T)) return escape(S, container)
    if (S.flags & NO_MEMBERS || S.flags & F.TypeParameter) return
    const key = `${container}|${typeId(S)}|${typeId(T)}|${cast}`
    if (memo.has(key)) return
    memo.add(key)
    if (S.flags & F.Union) {
      for (const s of S.types) flowTypes(s, T, container, depth, cast)
      return
    }
    T = checker.getNonNullableType(T)
    if (isArrayish(S) && constituents(T).some(isArrayish)) {
      for (const t of constituents(T).filter(isArrayish)) flowTypes(elementOf(S), elementOf(t), container, depth + 1)
      return
    }
    if (S.target && T.target && S.target === T.target) {
      const a = checker.getTypeArguments(S)
      const b = checker.getTypeArguments(T)
      a.forEach((arg, i) => flowTypes(arg, b[i], container, depth + 1))
      return
    }
    const pS = checker.getPromisedTypeOfPromise(S)
    const pT = checker.getPromisedTypeOfPromise(T)
    if (pS && pT) return flowTypes(pS, pT, container, depth + 1)
    if (flowSignatures(S, T, container, depth)) return
    if (isLibraryShape(S)) return libraryBacked(S, T, container)
    flowMembers(S, T, container, depth, cast)
  }

  /** A library object seen through our type (a canvas context as `Painter`): its members are the library's. */
  function libraryBacked(S, T, container) {
    for (const t of constituents(T)) {
      if (t.flags & NO_MEMBERS || isLibraryShape(t)) continue
      for (const tp of checker.getPropertiesOfType(t)) {
        if (checker.getPropertyOfType(S, tp.name)) graph.addRead(container, graph.idsOf(tp))
      }
    }
  }

  /** Both arms of `??`/`||`/`&&`/`?:`/`,` and through parentheses and `!`. */
  function flowExpr(expr, target, container, cast = false) {
    if (!expr || !target) return
    if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) return flowExpr(expr.expression, target, container, cast)
    const arms = choiceArms(expr)
    if (arms) {
      for (const arm of arms) flowExpr(arm, target, container, cast)
      return
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) return flowExpr(expr.right, target, container, cast)
    flowTypes(checker.getTypeAtLocation(expr), target, container, 0, cast)
  }

  /** The value-producing arms of `?:`, `??`, `||`, `&&` (else undefined). */
  function choiceArms(expr) {
    if (ts.isConditionalExpression(expr)) return [expr.whenTrue, expr.whenFalse]
    if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]
      .includes(expr.operatorToken.kind)) return [expr.left, expr.right]
    return undefined
  }

  /**
   * `(a ?? b).p`: the checker may reduce `A | B` to one structurally equal arm, so `p` resolves to A's
   * member only. Each arm flows into the type of the whole choice.
   */
  function choice(expr, container) {
    const arms = choiceArms(expr)
    if (!arms) return
    const whole = checker.getTypeAtLocation(expr)
    for (const arm of arms) flowTypes(checker.getTypeAtLocation(arm), whole, container)
  }

  /**
   * The callee's own parameter type when it is a bare type parameter (`z.object<T extends ZodRawShape>
   * (shape: T)`, or our own `f<T extends Record<string, unknown>>(x: T)`): the contextual type is the
   * inferred argument itself, which hides that the callee takes it as "any key" (escape through the
   * constraint) — or, unconstrained, hands it back unchanged (identity).
   */
  function declaredTypeParameter(node) {
    const call = node.parent
    const sig = checker.getResolvedSignature(call)
    const decl = sig?.getDeclaration?.()
    if (!decl || !decl.parameters) return undefined
    const i = call.arguments.indexOf(node)
    const param = decl.parameters[Math.min(i, decl.parameters.length - 1)]
    if (!param?.type || param.dotDotDotToken) return undefined
    const declared = checker.getTypeAtLocation(param.type)
    return declared.flags & F.TypeParameter ? declared : undefined
  }

  function inSlot(node) {
    const p = node.parent
    if (!p) return false
    switch (p.kind) {
      case ts.SyntaxKind.VariableDeclaration:
      case ts.SyntaxKind.Parameter:
      case ts.SyntaxKind.PropertyDeclaration:
        return p.initializer === node && Boolean(p.type)
      case ts.SyntaxKind.CallExpression:
      case ts.SyntaxKind.NewExpression:
        return Boolean(p.arguments?.includes(node))
      case ts.SyntaxKind.ReturnStatement:
        return true
      case ts.SyntaxKind.ArrowFunction:
        return p.body === node
      case ts.SyntaxKind.BinaryExpression:
        return p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === node
      case ts.SyntaxKind.PropertyAssignment:
        return p.initializer === node
      case ts.SyntaxKind.ArrayLiteralExpression:
        return true
      case ts.SyntaxKind.JsxExpression:
        return ts.isJsxAttribute(p.parent)
      default:
        return false
    }
  }

  /** `node` sits in a contextually typed slot: its value flows into that type. */
  function slot(node, container) {
    if (ts.isSpreadAssignment(node)) {
      return flowExpr(node.expression, checker.getContextualType(node.parent), container)
    }
    if (choiceArms(node)) choice(node, container)
    if (!inSlot(node) || ts.isPartOfTypeNode(node)) return
    const p = node.parent
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== node) {
      const declared = declaredTypeParameter(node)
      if (declared) return flowTypes(checker.getTypeAtLocation(node), declared, container)
    }
    const target = p.kind === ts.SyntaxKind.JsxExpression ? checker.getContextualType(p) ?? checker.getContextualType(node) : checker.getContextualType(node)
    if (target) flowExpr(node, target, container)
  }

  /** `x as T`, `<T>x`, `x satisfies T`: x's value is seen as T. */
  function assertion(node, container) {
    if (ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === 'const') return
    flowExpr(node.expression, checker.getTypeFromTypeNode(node.type), container, !ts.isSatisfiesExpression(node))
  }

  /** `class K implements I` / `extends B`: reading I.m / B.m (through the base type) reads K.m. */
  function heritage(node, container) {
    const sym = node.name ? checker.getSymbolAtLocation(node.name) : checker.getTypeAtLocation(node).symbol
    if (!sym) return
    const instance = checker.getDeclaredTypeOfSymbol(sym)
    for (const clause of node.heritageClauses ?? []) {
      for (const ht of clause.types) {
        const base = checker.getTypeAtLocation(ht)
        flowTypes(instance, base, container)
        if (clause.token === ts.SyntaxKind.ExtendsKeyword && allLibrary(base.symbol)) {
          // Framework classes (React.Component, Error) call static hooks by name.
          for (const m of node.members) {
            const id = graph.declId.get(m)
            if (id !== undefined && graph.nodes[id].isStatic) graph.addRead(container, [id])
          }
        }
      }
    }
  }

  return { constituents, propSymbols, slot, flowExpr, assertion, heritage, escape, flowTypes }
}
