/**
 * @fileoverview Which translation keys the source code uses, read from the
 * TypeScript AST rather than with regular expressions. Shared by the i18n audit
 * (`i18n-check.mjs`) and its regression tests (`i18n-check.test.mjs`).
 *
 * Why an AST: the regex extractor this replaced took ONE namespace per file (the
 * first `useTranslation('ns')` it saw) and could not read a namespace array, so
 * it reported three keys as missing that render fine:
 *
 *   - `ProjectHeader.tsx` has two components; the second calls
 *     `useTranslation(['projectDetail', 'projects'])` and `t('header.back')`,
 *     which the regex charged to the FIRST component's `'assistant'` namespace.
 *   - `DocumentsTab.tsx` binds `t` to `'components'` in one component for
 *     `t('prototypeLink.openNewTab')`, but the file's first hook is
 *     `'projectDetail'`.
 *   - A JSDoc comment that mentions `t('...')` was read as a real call.
 *
 * Every `t` is now resolved through the `useTranslation(...)` call that bound it
 * in the enclosing scope (aliases like `{ t: tc }` included), with the hook's
 * namespace array and `keyPrefix`. A namespace array resolves the way i18next
 * resolves it: the key is looked up in each namespace in order and the first one
 * that has it wins.
 */

import ts from 'typescript'

/** i18next's plural suffixes (CLDR categories). */
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

/** The key without its plural suffix, or `null` when it has none. */
export function pluralBase(key) {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(suffix)) return key.slice(0, -suffix.length)
  }
  return null
}

/**
 * Whether a key present only in a TARGET locale is a legitimate plural form.
 *
 * It is when English has the same base either pluralised (`base_one` in a
 * language with more categories) or plain (`base`). The second case matters:
 * i18next looks up `base_<category>` before `base` whenever `count` is passed,
 * in every language, so a locale may pluralise a string English does not need
 * to (`showTop` → ja `showTop_other`).
 *
 * @param key the target-locale key
 * @param sourceKeys every English key of the same namespace
 */
export function isValidPluralVariant(key, sourceKeys) {
  const base = pluralBase(key)
  if (!base) return false
  return sourceKeys.has(base) || PLURAL_SUFFIXES.some((s) => sourceKeys.has(`${base}${s}`))
}

/** The literal text of a string or substitution-free template, else `null`. */
function staticString(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text
  return null
}

/**
 * Every key a `t(...)` first argument can be: a literal, or each branch of a
 * conditional whose branches are all static (`t(x ? 'a' : 'b')`) — that form
 * once hid two missing keys (`editor.fields.instructions[Required]`) that
 * shipped as raw key paths. `[]` for anything dynamic.
 */
function staticKeys(node) {
  const inner = node ? ts.skipOuterExpressions(node) : node
  const single = staticString(inner)
  if (single !== null) return [single]
  if (inner && ts.isConditionalExpression(inner)) {
    const whenTrue = staticKeys(inner.whenTrue)
    const whenFalse = staticKeys(inner.whenFalse)
    return whenTrue.length > 0 && whenFalse.length > 0 ? [...whenTrue, ...whenFalse] : []
  }
  return []
}

/** `'ns'` or `['ns1', 'ns2']` as a namespace list; `null` for anything dynamic. */
function namespaceList(node) {
  const single = staticString(node)
  if (single !== null) return [single]
  if (node && ts.isArrayLiteralExpression(node)) {
    const names = node.elements.map(staticString)
    return names.every((n) => n !== null) ? names : null
  }
  return null
}

/** The initializer of property `name` in an object literal, if present. */
function objectProperty(node, name) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined
  for (const prop of node.properties) {
    const key = ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null
    if (key === name) return prop.initializer
  }
  return undefined
}

/** A call to `useTranslation(...)`, unwrapped from parentheses. */
function asUseTranslationCall(node) {
  const inner = node ? ts.skipOuterExpressions(node) : node
  if (inner && ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'useTranslation') {
    return inner
  }
  return null
}

/**
 * The binding a `useTranslation(...)` call gives its `t`.
 *
 * @returns `{ namespaces, prefix }`, or `null` when the namespace is dynamic
 */
function hookBinding(call, defaultNs) {
  const [nsArg, optionsArg] = call.arguments
  const namespaces = nsArg === undefined ? [defaultNs] : namespaceList(nsArg)
  if (namespaces === null || namespaces.length === 0) return null
  const prefix = staticString(objectProperty(optionsArg, 'keyPrefix'))
  return { namespaces, prefix: prefix ? `${prefix}.` : '' }
}

/** `'ns'` or `['ns1', 'ns2']` written as a TYPE (`TFunction<'ns'>`), else `null`. */
function typeNamespaceList(node) {
  if (!node) return null
  if (ts.isLiteralTypeNode(node)) return ts.isStringLiteral(node.literal) ? [node.literal.text] : null
  if (ts.isTupleTypeNode(node)) {
    const names = node.elements.map((e) => (ts.isLiteralTypeNode(e) && ts.isStringLiteral(e.literal) ? e.literal.text : null))
    return names.length > 0 && names.every((n) => n !== null) ? names : null
  }
  return null
}

/**
 * The namespaces of a `t` prop/parameter declared as `t: TFunction<'ns'>`.
 *
 * A component that receives its parent's `t` (instead of calling the hook) says
 * which namespace that `t` is bound to through this type; without it the audit
 * would charge the keys to the file's first hook or the default namespace.
 */
function typedTBinding(node) {
  const isTDeclaration = (ts.isPropertySignature(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.name.text === 't'
  const type = isTDeclaration ? node.type : undefined
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeName.text !== 'TFunction') return null
  const namespaces = typeNamespaceList(type.typeArguments?.[0])
  return namespaces ? { namespaces, prefix: '' } : null
}

/** The local name `t` is bound to in `const { t } = …` / `const { t: tc } = …`. */
function boundTName(pattern) {
  if (!ts.isObjectBindingPattern(pattern)) return null
  for (const element of pattern.elements) {
    const property = element.propertyName ?? element.name
    if (ts.isIdentifier(property) && property.text === 't' && ts.isIdentifier(element.name)) return element.name.text
  }
  return null
}

/** Whether `node` opens a new scope for `t` bindings. */
function opensScope(node) {
  return ts.isFunctionLike(node) || ts.isBlock(node) || ts.isSourceFile(node)
}

/**
 * The namespaces/prefix that apply to one `t(...)` call: its explicit `ns:`
 * option or `ns:key` prefix first, then the hook binding.
 */
function resolveCall(rawKey, optionsArg, binding, namespaces) {
  const colon = rawKey.indexOf(':')
  if (colon > 0 && namespaces.includes(rawKey.slice(0, colon))) {
    return { namespaces: [rawKey.slice(0, colon)], key: rawKey.slice(colon + 1) }
  }
  const explicitNs = namespaceList(objectProperty(optionsArg, 'ns'))
  return { namespaces: explicitNs ?? binding.namespaces, key: `${binding.prefix}${rawKey}` }
}

/**
 * Every static translation key one source file passes to a `t` function.
 *
 * A `t` that no `useTranslation` in scope binds (a `t` parameter of a helper,
 * `i18n.t`, `i18next.t`) resolves through the file's first `t: TFunction<'ns'>`
 * declaration, else the file's first hook, else the default namespace.
 * Keys built at runtime (template literals with substitutions, variables) are
 * not static and are skipped.
 *
 * @param fileName used only to pick the parser's script kind
 * @param content the file's source text
 * @param options `{ defaultNs, namespaces }` — the shipped namespace list decides
 *   whether a colon in a key is a namespace separator
 * @returns `{ namespaces, key }` usages; `namespaces` is in lookup order
 */
export function extractKeyUsages(fileName, content, { defaultNs, namespaces }) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, kind)
  const usages = []
  let fileFallback = null
  let typedFallback = null
  const scopes = []

  const lookup = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const hit = scopes[i].get(name)
      if (hit) return hit
    }
    return null
  }

  const recordBinding = (node) => {
    if (!ts.isVariableDeclaration(node)) return
    const call = asUseTranslationCall(node.initializer)
    const name = call ? boundTName(node.name) : null
    const binding = call && name ? hookBinding(call, defaultNs) : null
    if (!binding) return
    scopes.at(-1)?.set(name, binding)
  }

  const recordCall = (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    const isBareT = ts.isIdentifier(callee)
    const isMemberT = ts.isPropertyAccessExpression(callee) && callee.name.text === 't'
    if (!isBareT && !isMemberT) return
    const bound = isBareT ? lookup(callee.text) : null
    if (isBareT && !bound && callee.text !== 't') return
    const rawKeys = staticKeys(node.arguments[0])
    if (rawKeys.length === 0) return
    const binding = bound ?? typedFallback ?? fileFallback ?? { namespaces: [defaultNs], prefix: '' }
    for (const rawKey of rawKeys) usages.push(resolveCall(rawKey, node.arguments[1], binding, namespaces))
  }

  const visit = (node) => {
    const scoped = opensScope(node)
    if (scoped) scopes.push(new Map())
    recordBinding(node)
    recordCall(node)
    ts.forEachChild(node, visit)
    if (scoped) scopes.pop()
  }

  // Hooks are bound before their t is called in every component, but the
  // file-level fallback must see the FIRST hook even for a helper defined above
  // it, so it is found in a pre-pass.
  const findFirstHook = (node) => {
    typedFallback ??= typedTBinding(node)
    if (!fileFallback && ts.isVariableDeclaration(node)) {
      const call = asUseTranslationCall(node.initializer)
      if (call && boundTName(node.name)) fileFallback = hookBinding(call, defaultNs)
    }
    ts.forEachChild(node, findFirstHook)
  }
  findFirstHook(source)
  visit(source)
  return usages
}

/** `ns → Set<key>` plus each plural key's base, i.e. what `t(base, { count })` finds. */
function lookupSets(englishKeys) {
  const sets = new Map()
  for (const [ns, keys] of englishKeys) {
    const set = new Set(keys)
    for (const key of keys) {
      const base = pluralBase(key)
      if (base) set.add(base)
    }
    sets.set(ns, set)
  }
  return sets
}

/**
 * Resolve usages against the English catalogue the way i18next would.
 *
 * @param usages from {@link extractKeyUsages}
 * @param englishKeys `ns → Set<key>` of the English files
 * @returns `used` — the `ns:key` each usage resolved to (the first namespace in
 *   lookup order that has it); `missing` — `ns:key` (first namespace) for each
 *   usage no namespace has, interpolation-shaped keys excluded
 */
export function resolveKeyUsages(usages, englishKeys) {
  const sets = lookupSets(englishKeys)
  const used = new Set()
  const missing = new Set()
  for (const { namespaces, key } of usages) {
    const hit = namespaces.find((ns) => sets.get(ns)?.has(key))
    if (hit !== undefined) {
      used.add(`${hit}:${key}`)
    } else if (!key.includes('$') && !key.includes('{')) {
      missing.add(`${namespaces[0]}:${key}`)
    }
  }
  return { used, missing: [...missing] }
}
