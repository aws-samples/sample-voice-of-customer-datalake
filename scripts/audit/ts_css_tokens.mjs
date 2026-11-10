#!/usr/bin/env node
// audit-detector: run by scripts/audit/run-all.sh
/**
 * ts_css_tokens — CSS custom properties, keyframes and classes of the SPA that nothing uses.
 *
 * Pattern (hunt-typescript.md §J: `--color-card-fg` / `--card-fg`, `--color-muted-fg`, five `--animate-*`
 * tokens and their `@keyframes`, `.scrollbar-hide`): a token or recipe outlives the last component that
 * used it. It still ships, still appears in the design-system docs as something to reach for, and each
 * theme keeps defining the raw value behind it.
 *
 * How: the SPA's stylesheets (`frontend/src/**.css`, comments stripped) are read into
 *   - definitions: custom properties (`--x:` in any block), `@keyframes x`, plain class selectors (`.x`)
 *     and `@utility x`;
 *   - edges: the `var(--y)` and keyframe names in the VALUE of a custom-property definition (`--a: var(--b)`
 *     uses `--b` only if `--a` is used);
 *   - roots: `var(--x)` / keyframe names in ordinary declarations, the `@apply` lines, and the production
 *     source (ts/tsx/js of `src/`, `index.html`, `public/**.{html,js}`) as text.
 * Tailwind v4 turns `@theme` variables into utilities, so a theme token is used by its utility tokens in the
 * source or an `@apply`: `--color-foo` by `bg-foo`, `text-foo`, `border-foo`, `ring-foo`, `fill-foo`, … (with
 * variants and `/opacity`), `--animate-foo` by `animate-foo`, `--font-foo` by `font-foo`, `--radius-foo` by
 * `rounded(-side)-foo`, `--shadow-foo` by `shadow-foo`. Tailwind only generates a utility it sees written in
 * full, so a template such as `` `text-${tone}` `` uses no theme token; a plain CSS class, which always ships,
 * counts as used by a template head (`` `badge-${tone}` `` uses every `.badge-*`). Liveness is solved as a fixed
 * point, so a raw `--card-fg` read only by a dead `--color-card-fg` is dead too. A `@theme` namespace this
 * mapping does not model counts as used.
 *
 * Never judged: library namespaces (`--xy-*`, `.react-flow__*`, `--tw-*`) and the variables Tailwind's preflight
 * reads (`--font-sans`, `--font-mono`, `--default-*`); they are roots.
 *
 * Kinds: `unused-property`, `unused-keyframes`, `unused-class`. Key: `css:--x`, `css:@keyframes x`, `css:.x`.
 * Allowlist `scripts/audit/allowlists/ts_css_tokens.json`.
 *
 * Why the reference tools miss it: tsc, eslint and knip do not read CSS; Tailwind drops unused utilities
 * from the build but never reports the theme variables, keyframes and recipes behind them.
 *
 * Usage: node scripts/audit/ts_css_tokens.mjs [--root <repo>] [--json [PATH]] [--no-allowlist] [--help]
 * Exit: 0 clean, 1 findings, 2 error/vacuous scan.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  AuditError, REPO_ROOT, detectorMain, finishReport, isTestPath, posixRel, runIfMain, walkFiles,
} from './audit_common.mjs'

const TOOL = 'ts_css_tokens'
const MIN_PROPERTIES = 100
const FRONTEND = 'voc-datalake/frontend'
const LIBRARY = [/^--xy-/, /^--tw-/, /^\.react-flow__/, /^--font-(sans|mono)$/, /^--default-/]
const COLOR_UTILS = 'bg|text|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|from|via|to|outline|divide|placeholder|caret|accent|decoration|shadow|inset-shadow|drop-shadow|inset-ring'
/** `@theme` namespace → the utility prefixes that read it. */
const THEME_UTILS = { color: COLOR_UTILS, animate: 'animate', font: 'font', radius: 'rounded(?:-[trblse]{1,2})?', shadow: 'shadow' }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lineOf = (text, index) => text.slice(0, index).split('\n').length
const isLibrary = (name) => LIBRARY.some((re) => re.test(name))

/** Comments blanked out (same length, so indexes keep their line numbers). */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))

/** Is `index` inside an `@theme { … }` block? */
function themeRanges(css) {
  const out = []
  for (const m of css.matchAll(/@theme\b[^{]*\{/g)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < css.length && depth; i += 1) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0
    out.push([m.index, i])
  }
  return (index) => out.some(([a, b]) => index > a && index < b)
}

const varRefs = (value) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])
const words = (value) => [...value.matchAll(/[A-Za-z_][\w-]*/g)].map((m) => m[0])

/** Definitions, edges and roots of one stylesheet. */
export function readStylesheet(rel, raw, model) {
  const css = stripComments(raw)
  const inTheme = themeRanges(css)
  const define = (name, kind, index, theme = false) => {
    if (!model.defs.has(name)) model.defs.set(name, { name, kind, where: `${rel}:${lineOf(css, index)}`, theme })
    else if (theme) model.defs.get(name).theme = true
  }
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) define(`@keyframes ${m[1]}`, 'unused-keyframes', m.index)
  for (const m of css.matchAll(/@utility\s+([\w-]+)/g)) define(`.${m[1]}`, 'unused-class', m.index)
  // Declarations: `prop: value` right after `{` or `;`, ended by `;` or `}`.
  for (const m of css.matchAll(/(?<=[{;]\s*)(-{0,2}[A-Za-z_][\w-]*)\s*:\s*([^;{}]*)(?=[;}])/g)) {
    const [, prop, value] = m
    const refs = [...varRefs(value), ...words(value).map((w) => `@keyframes ${w}`)]
    if (prop.startsWith('--')) {
      define(prop, 'unused-property', m.index, inTheme(m.index))
      model.edges.set(prop, [...(model.edges.get(prop) ?? []), ...refs])
    } else {
      refs.forEach((r) => model.roots.add(r))
    }
  }
  for (const m of css.matchAll(/@apply\s+([^;]+);/g)) model.apply.push(m[1])
  // Class selectors: the prelude before each `{` that is not an at-rule.
  for (const m of css.matchAll(/(^|[{};])([^{};]*)\{/g)) {
    const prelude = m[2]
    if (prelude.trim().startsWith('@')) continue
    const start = m.index + m[1].length
    for (const c of prelude.matchAll(/\.([A-Za-z_][\w-]*)/g)) define(`.${c[1]}`, 'unused-class', start + c.index)
  }
}

/** The text tokens of the production source, and the template heads (`badge-${`) that name class families. */
function sourceText(files) {
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n')
  const heads = new Set([...text.matchAll(/(?<![\w-])(-{0,2}[A-Za-z][\w-]*-)\$\{/g)].map((m) => m[1]))
  return { text, heads }
}

/** Is the `@theme` token `name` used by a utility written in `text`? */
function themeTokenUsed(name, text) {
  const m = /^--([a-z]+)-(.+)$/.exec(name)
  const utils = m && THEME_UTILS[m[1]]
  if (!utils) return true
  const re = new RegExp(`(?<![\\w-])(?:[\\w-]+:|\\[[^\\]]*\\]:)*!?-?(?:${utils})-${esc(m[2])}(?:/[\\w.]+)?!?(?![\\w-])`)
  return re.test(text)
}

export function analyzeCss({ stylesheets, sources }) {
  const model = { defs: new Map(), edges: new Map(), roots: new Set(), apply: [] }
  for (const { rel, text } of stylesheets) readStylesheet(rel, text, model)
  const { text, heads } = sourceText(sources)
  // A template head names a family: `badge-${` every `.badge-*` class, `--chart-${` every `--chart-*` read.
  const byHead = (bare) => [...heads].some((h) => bare.startsWith(h))
  const usedText = `${text}\n${model.apply.join('\n')}`
  const live = new Set()
  const queue = []
  const mark = (name) => { if (!live.has(name)) { live.add(name); queue.push(name) } }
  for (const def of model.defs.values()) {
    const { name } = def
    const bare = name.replace(/^(@keyframes |\.)/, '')
    const token = new RegExp(`(?<![\\w-])${esc(name.startsWith('--') ? name : bare)}(?![\\w-])`)
    if (isLibrary(name) || model.roots.has(name) || token.test(usedText)) mark(name)
    else if (def.theme && themeTokenUsed(name, usedText)) mark(name)
    else if (def.kind === 'unused-class' && byHead(bare)) mark(name)
    else if (def.kind === 'unused-property' && !def.theme && byHead(name)) mark(name)
  }
  for (const r of model.roots) if (!model.defs.has(r)) live.add(r)
  while (queue.length) for (const next of model.edges.get(queue.pop()) ?? []) mark(next)
  const findings = [...model.defs.values()].filter((d) => !live.has(d.name))
    .map((d) => ({ key: `css:${d.name}`, kind: d.kind, detail: `defined at ${d.where}${d.theme ? ' (@theme)' : ''}` }))
  const properties = [...model.defs.values()].filter((d) => d.kind === 'unused-property').length
  return { findings, properties, definitions: model.defs.size }
}

/** The SPA's stylesheets and production sources under `root`. */
export function realInputs(root = REPO_ROOT) {
  const fe = join(root, FRONTEND)
  const rel = (f) => posixRel(root, f)
  const stylesheets = walkFiles(join(fe, 'src'), (name) => name.endsWith('.css')).map((f) => ({ rel: rel(f), text: readFileSync(f, 'utf8') }))
  const sources = [
    ...walkFiles(join(fe, 'src'), (name) => /\.(tsx?|jsx?)$/.test(name)),
    join(fe, 'index.html'),
    ...walkFiles(join(fe, 'public'), (name) => /\.(html|js)$/.test(name)),
  ].filter((f) => !isTestPath(rel(f)))
  return { stylesheets, sources }
}

export const main = detectorMain(TOOL, {
  usage: 'SPA CSS custom properties, keyframes and classes nothing uses (Tailwind v4 @theme utilities followed).',
  spec: { root: 'string', 'no-allowlist': 'boolean' },
}, (args) => {
  const { findings, properties, definitions } = analyzeCss(realInputs(args.root ? resolve(args.root) : undefined))
  if (properties < MIN_PROPERTIES) throw new AuditError(`vacuous scan: ${properties} custom properties (expected at least ${MIN_PROPERTIES})`)
  return finishReport(TOOL, args, findings, { summary: `${definitions} CSS definitions (${properties} custom properties)`, reportStale: !args.root })
})

runIfMain(import.meta.url, main)
