#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_locale_keys — English locale keys no production source can reach.
 *
 * Pattern (the 5.28 dead-TS audit: 48 keys, e.g. the 17 `projectDetail:wizards.*` leftovers of old wizard copy):
 * a key whose last `t()` caller was deleted stays in all 9 catalogues forever, translated and shipped.
 *
 * How: the SPA's own audit logic finds the keys `t()` calls resolve to — `frontend/scripts/i18n-keys.mjs`
 * (`extractKeyUsages`/`resolveKeyUsages`, scope-aware, `keyPrefix`, namespace arrays) over the same
 * production files `i18n-check.mjs` reads. Every key it reports as "not directly referenced" is then
 * matched, like the 5.28 audit did by hand, against the production source (TypeScript AST):
 *   - a string literal equal to the key, to `ns:key`, or to a dot-suffix of it that has a dot itself
 *     (`labelKey: 'fields.name'` held in a table);
 *   - a template literal with substitutions as a wildcard (`\`aiModel.surfaces.${k}.label\``), against
 *     the key, `ns:key` and every dot-suffix (a template under a `keyPrefix` hook);
 *   - a quoted ancestor prefix: a literal ending in `.` (`'jobs.types.' + type`), a multi-segment
 *     literal the key starts with, or any literal passed to `t(…, { returnObjects: true })`;
 *   - plural bases: `x_one`/`x_other` are reached through `x`.
 * What is left has no literal, template, prefix, plural-base or returnObjects match.
 *
 * Why the reference tools miss it: `i18n-check.mjs` reports ~950 "not directly referenced" keys and
 * cannot tell the 693 template-reached ones from the dead ones, so it is informational only; knip and
 * tsc do not read JSON.
 *
 * Known false-positive classes (allowlist `scripts/audit/allowlists/ts_locale_keys.json`, key `ns:key`,
 * `*` allowed, e.g. `projectDetail:importPersona.uploadPdf` kept for the PDF work):
 *   - keys built from a variable holding the whole key (`t(keyFromServer)`);
 *   - copy staged for an upcoming feature (say which in the reason).
 *
 * Usage: node scripts/audit/ts_locale_keys.mjs [--root <repo>] [--json [PATH]] [--no-allowlist] [--delete] [--help]
 * `--delete` removes every reported key (after the allowlist) from all 9 locales, plural variants of a
 * fully removed base included, and prunes emptied objects (JSON written 2-space, trailing newline).
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  AuditError, REPO_ROOT, applyAllowlist, detectorMain, finishReport, loadAllowlist, loadTypeScript, runIfMain, walkFiles,
} from './audit_common.mjs'

const TOOL = 'ts_locale_keys'
const DEFAULT_NS = 'common'
const MIN_KEYS = 3000

/** The production files i18n-check.mjs reads: src/**.{ts,tsx} without specs and src/test. */
export function productionSources(srcDir) {
  return walkFiles(srcDir, (name, full) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\/test\//.test(full.slice(srcDir.length)))
}

/** Literals, template wildcards and prefixes of the production source. */
export function sourceMatchers(ts, files) {
  const literals = new Set()
  const templates = []
  const prefixes = new Set()
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const visit = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const v = node.text
        literals.add(v)
        if (v.endsWith('.') && v.length > 1) prefixes.add(v.slice(0, -1))
        if (isReturnObjectsArg(ts, node)) prefixes.add(v)
      } else if (ts.isTemplateExpression(node)) {
        const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)]
        // `\`${ns}:${key}\``, `\`${a}_${b}\``, `\`p${n}\`` carry no key text: they would match almost every key.
        if ((parts.join('').match(/[A-Za-z0-9]/g) ?? []).length >= 3) templates.push(new RegExp(`^${parts.map(esc).join('.+')}$`))
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { literals, templates, prefixes }
}

function isReturnObjectsArg(ts, node) {
  const call = node.parent
  if (!ts.isCallExpression(call) || call.arguments[0] !== node) return false
  const opts = call.arguments[1]
  return Boolean(opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => p.name?.getText() === 'returnObjects'))
}

/** Does any matcher reach `ns:key`? */
export function isReached(ns, key, { literals, templates, prefixes }) {
  const full = `${ns}:${key}`
  const segments = key.split('.')
  const suffixes = segments.map((_, i) => segments.slice(i).join('.'))
  if (literals.has(key) || literals.has(full) || suffixes.slice(1).some((s) => s.includes('.') && literals.has(s))) return true
  if (templates.some((re) => re.test(key) || re.test(full) || suffixes.some((s) => re.test(s)))) return true
  for (let i = 1; i < segments.length; i += 1) {
    const ancestor = segments.slice(0, i).join('.')
    if ((i > 1 && literals.has(ancestor)) || prefixes.has(ancestor) || prefixes.has(`${ns}:${ancestor}`) || literals.has(`${ns}:${ancestor}`)) return true
  }
  return false
}

/** The repo's own i18n helpers (from the tree being audited). */
async function i18nHelpers(root) {
  const dir = join(root, 'voc-datalake/frontend/scripts')
  const keys = await import(pathToFileURL(join(dir, 'i18n-keys.mjs')).href)
  const locales = await import(pathToFileURL(join(dir, 'i18n-locales.mjs')).href)
  return { ...keys, ...locales }
}

/** `[{ns, key}]` English keys unreached by t() resolution and every source matcher. */
export async function unusedKeys(root) {
  const h = await i18nHelpers(root)
  const namespaces = h.localeNamespaces('en')
  const english = new Map(namespaces.map((ns) => [ns, new Set(h.flattenEntries(h.loadLocale('en', ns) ?? {}).map(([k]) => k))]))
  const srcDir = join(root, 'voc-datalake/frontend/src')
  const files = productionSources(srcDir)
  const usages = files.flatMap((f) => h.extractKeyUsages(f, readFileSync(f, 'utf8'), { defaultNs: DEFAULT_NS, namespaces }))
  const { used } = h.resolveKeyUsages(usages, english)
  const matchers = sourceMatchers(loadTypeScript(root), files)
  const out = []
  let total = 0
  for (const [ns, keys] of english) {
    for (const key of keys) {
      total += 1
      const base = h.pluralBase(key)
      const candidates = base ? [key, base] : [key]
      if (candidates.some((k) => used.has(`${ns}:${k}`) || isReached(ns, k, matchers))) continue
      out.push({ ns, key })
    }
  }
  return { unused: out, total, files: files.length, helpers: h }
}

/** Remove `dotted` from a nested object; prune emptied parents. True when something was removed. */
export function deleteNested(obj, dotted) {
  const [head, ...rest] = dotted.split('.')
  if (!(head in obj)) return false
  if (!rest.length) {
    delete obj[head]
    return true
  }
  const child = obj[head]
  if (child === null || typeof child !== 'object') return false
  const removed = deleteNested(child, rest.join('.'))
  if (removed && !Object.keys(child).length) delete obj[head]
  return removed
}

const PLURALS = ['_zero', '_one', '_two', '_few', '_many', '_other']

/** Delete the keys from every locale of the audited tree; returns the number of entries removed. */
export function deleteKeys(root, keys, helpers) {
  const localesDir = join(root, 'voc-datalake/frontend/public/locales')
  const langs = walkFiles(localesDir, (name) => name === 'common.json').map((f) => f.split('/').at(-2))
  let removed = 0
  const byNs = new Map()
  for (const { ns, key } of keys) byNs.set(ns, [...(byNs.get(ns) ?? []), key])
  for (const [ns, list] of byNs) {
    const english = new Set(helpers.flattenEntries(helpers.loadLocale('en', ns) ?? {}).map(([k]) => k))
    const gone = new Set(list)
    // A plural base whose every English form goes takes the target locales' extra forms with it.
    const bases = new Set(list.map((k) => helpers.pluralBase(k)).filter((b) => b && ![...english].some((k) => helpers.pluralBase(k) === b && !gone.has(k))))
    for (const lang of langs) {
      const file = join(localesDir, lang, `${ns}.json`)
      let data
      try {
        data = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      const targets = [...list, ...[...bases].flatMap((b) => PLURALS.map((s) => `${b}${s}`))]
      let changed = false
      for (const key of new Set(targets)) {
        if (deleteNested(data, key)) {
          removed += 1
          changed = true
        }
      }
      if (changed) writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
    }
  }
  return removed
}

export const main = detectorMain(TOOL, {
  usage: 'English locale keys nothing in the production source can reach; --delete removes them from every locale.',
  spec: { root: 'string', 'no-allowlist': 'boolean', delete: 'boolean' },
}, async (args) => {
  const root = args.root ? resolve(args.root) : REPO_ROOT
  const { unused, total, files, helpers } = await unusedKeys(root)
  if (total < MIN_KEYS || files < 300) throw new AuditError(`vacuous scan: ${total} English keys, ${files} source files`)
  const findings = unused.map(({ ns, key }) => ({ key: `${ns}:${key}`, kind: 'unreached-key', detail: '' }))
  const code = finishReport(TOOL, args, findings, { summary: `${total} English keys, ${files} source files`, reportStale: !args.root })
  if (args.delete) {
    const entries = args['no-allowlist'] ? [] : loadAllowlist(TOOL)
    const doomed = applyAllowlist(findings, entries, { reportStale: false }).left.map((f) => {
      const [ns, key] = f.key.split(/:(.*)/s)
      return { ns, key }
    })
    console.error(`${TOOL}: deleted ${deleteKeys(root, doomed, helpers)} locale entries`)
  }
  return code
})

runIfMain(import.meta.url, main)
