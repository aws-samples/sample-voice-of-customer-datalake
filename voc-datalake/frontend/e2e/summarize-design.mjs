#!/usr/bin/env node
/**
 * Summarizes a design-track evidence directory (tests/design-*.spec.ts):
 * per screen a 0–100 score (worst variant across role × theme × viewport) and
 * its findings, plus roll-ups by rule across the whole run. Writes
 * design-summary.json and design-summary.md next to the input.
 *
 * Usage: node e2e/summarize-design.mjs <E2E_OUT> [screens-dir]
 *
 * Score: 100 minus weighted penalties per DISTINCT finding (not per node), so a
 * screen with one repeated defect is not buried under its node count:
 * axe critical 15 · serious 8 · moderate 4 · minor 2; text contrast < AA 5 (max 30);
 * focus indicator missing 4 / < 3:1 3 (max 20); overlay not closing on Escape 10,
 * focus not returned 6, focus escapes a modal 6; overflow at the width 8;
 * off-palette 3; type-scale / weight / font 2; truncated without tooltip 2;
 * small text 1 (max 5); control boundary < 3:1 1 (max 3); radius / spacing 1 (max 3).
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? 'e2e-output'
const stepsDir = path.join(dir, 'steps')
const files = fs.readdirSync(stepsDir).filter((f) => f.endsWith('.json') && !f.endsWith('-login.json'))
const records = files.map((f) => JSON.parse(fs.readFileSync(path.join(stepsDir, f), 'utf8')))

const AXE_W = { critical: 15, serious: 8, moderate: 4, minor: 2 }
const cap = (n, max) => Math.min(n, max)

/** "desktop-overlay-create-project" → { viewport, screen } */
function split(step) {
  const m = step.match(/^(desktop|mobile|zoom200)-(.*)$/)
  return m ? { viewport: m[1], screen: m[2] } : { viewport: '?', screen: step }
}

function findingsOf(r) {
  const out = []
  const add = (sev, rule, detail, weight) => out.push({ sev, rule, detail, weight })
  if (new URL(r.url).pathname === '/login' && !r.step.includes('login')) add('info', 'session', 'landed on /login (session expired) — rerun', 0)
  for (const v of r.axe?.violations ?? []) add(v.impact, `axe:${v.id}`, `${v.help} (${v.nodes} nodes) e.g. ${v.targets.slice(0, 2).join(' | ')}`, AXE_W[v.impact] ?? 2)
  const d = r.extra?.deep
  if (d) {
    const textC = d.contrast.filter((c) => ['text', 'large-text', 'svg-text', 'placeholder'].includes(c.kind))
    for (const c of textC) add('serious', `contrast:${c.kind}`, `${c.ratio}:1 < ${c.required} "${c.text}" fg ${c.fg} on ${c.bg} @ ${c.selector}`, 5)
    for (const c of d.contrast.filter((x) => x.kind === 'control-border')) add('moderate', 'contrast:control-boundary', `${c.ratio}:1 < 3 ${c.text} @ ${c.selector}`, 1)
    for (const o of d.offPalette) add('moderate', 'token:off-palette', `${o.property} ${o.value} ×${o.count} @ ${o.selector}`, 3)
    for (const o of d.fonts) add('moderate', 'token:font', `${o.value} @ ${o.selector}`, 2)
    for (const o of d.typeScale) add('minor', 'token:type-scale', `${o.value} "${o.text}" @ ${o.selector}`, 2)
    for (const o of d.weights) add('minor', 'token:weight', `${o.value} @ ${o.selector}`, 2)
    for (const o of d.radius) add('minor', 'token:radius', `${o.value} @ ${o.selector}`, 1)
    for (const o of d.spacing) add('minor', 'token:spacing', `${o.property} ${o.value} @ ${o.selector}`, 1)
    for (const s of d.smallText) add('minor', 'read:small-text', `${s.fontPx}px "${s.text}" @ ${s.selector}`, 1)
    for (const s of d.truncatedNoTooltip) add('moderate', 'read:truncated-no-tooltip', `"${s.text}" @ ${s.selector}`, 2)
    for (const s of d.longLines) add('minor', 'read:long-lines', `${s.chars} chars/line @ ${s.selector}`, 1)
    for (const s of d.nonLucideSvgs) add('minor', 'icon:non-lucide', `${s.selector} viewBox=${s.viewBox}`, 2)
    if (d.emojis.length > 0) add('moderate', 'content:emoji', d.emojis.join(' '), 3)
    if (d.overflow.documentScrollWidth > d.overflow.viewportWidth + 1 || d.overflow.offenders.length > 0) {
      add('serious', 'layout:overflow', `scrollWidth ${d.overflow.documentScrollWidth} > ${d.overflow.viewportWidth}; ${d.overflow.offenders.slice(0, 3).map((o) => `${o.selector} (right ${o.right})`).join(' | ')}`, 8)
    }
    if (d.landmarks.main !== 1) add('moderate', 'struct:main', `${d.landmarks.main} main landmarks`, 3)
    if (d.landmarks.h1 !== 1) add('minor', 'struct:h1', `${d.landmarks.h1} h1`, 2)
    for (const s of d.landmarks.headingSkips) add('minor', 'struct:heading-skip', s, 1)
  }
  const k = r.extra?.keyboard
  if (k) {
    for (const s of k.noIndicator) add('serious', 'kbd:no-focus-indicator', `${s.selector} "${s.name}"`, 4)
    for (const s of k.lowContrastIndicator) add('moderate', 'kbd:focus-indicator-contrast', `${s.indicatorContrast}:1 ${s.indicator.slice(0, 60)} @ ${s.selector} "${s.name}"`, 3)
    for (const s of k.obscured) add('moderate', 'kbd:focus-obscured', `${s.selector} "${s.name}"`, 3)
    for (const u of k.unreached) add('moderate', 'kbd:unreached', u, 2)
    for (const p of k.positiveTabindex) add('minor', 'kbd:positive-tabindex', p, 2)
  }
  const o = r.extra?.overlay
  if (o && o.opened) {
    if (o.escape === 'STILL OPEN') add('serious', 'overlay:escape', `"${o.name}" stays open on Escape`, 10)
    // Focus is not expected back on the trigger when the popup closed because Tab moved focus on.
    const closedByTab = o.openAfterTab === false
    if (o.focusReturned === false && !closedByTab) add('moderate', 'overlay:focus-return', `"${o.name}": focus not back on the trigger after Escape`, 6)
    if (o.focusMovedIn === false) add('moderate', 'overlay:focus-in', `"${o.name}": focus stays on the trigger when opened`, 4)
    const modal = o.modal ?? !/time-range|popup-|assistant-panel/.test(r.step)
    if (o.trap && o.trap.escapes > 0 && modal) add('moderate', 'overlay:focus-escapes', `"${o.name}": ${o.trap.escapes}/${o.trap.stops} Tab presses left the modal (e.g. ${o.trap.samples.slice(0, 2).join(', ')})`, 6)
    // The docked assistant panel is deliberately persistent (it is the app-wide chat, not a popup).
    const persistent = /assistant-panel$/.test(r.step)
    if (o.trap && o.trap.escapes > 0 && !modal && !persistent && o.openAfterTab !== false) add('minor', 'overlay:open-after-focus-leaves', `"${o.name}": non-modal popup stays open after Tab leaves it`, 2)
    if (o.motion && o.motion.longestMs > 1) add('moderate', 'motion:reduced', `longest ${o.motion.longestMs} ms under reduce: ${o.motion.offenders.slice(0, 2).join(' | ')}`, 4)
  }
  return out
}

function scoreOf(findings) {
  const sum = (rulePrefix, max) => cap(findings.filter((f) => f.rule.startsWith(rulePrefix)).reduce((a, f) => a + f.weight, 0), max)
  const groups = [
    sum('axe:', 100), sum('contrast:text', 30), sum('contrast:large', 15), sum('contrast:svg', 15), sum('contrast:placeholder', 10),
    sum('contrast:control', 3), sum('kbd:', 20), sum('overlay:', 25), sum('motion:', 8), sum('layout:', 8), sum('token:off', 12),
    sum('token:font', 6), sum('token:type', 6), sum('token:weight', 4), sum('token:radius', 3), sum('token:spacing', 3),
    sum('read:small', 5), sum('read:trunc', 8), sum('read:long', 3), sum('icon:', 4), sum('content:', 3), sum('struct:', 6),
  ]
  return Math.max(0, 100 - groups.reduce((a, b) => a + b, 0))
}

const screens = new Map()
const rollup = new Map()
for (const r of records) {
  const { viewport, screen } = split(r.step)
  const variant = `${r.role}/${r.theme}/${viewport}`
  const findings = findingsOf(r)
  const entry = screens.get(screen) ?? { screen, variants: [], findings: new Map() }
  entry.variants.push({ variant, score: scoreOf(findings), screenshot: r.screenshot, axe: r.axe?.counts ?? null, ok: r.ok, error: r.error })
  for (const f of findings) {
    const key = `${f.rule}|${f.detail.replace(/\d+(\.\d+)?:1/, '').replace(/ ×\d+/, '').replace(/\(\d+ nodes\)/, '')}`
    const e = entry.findings.get(key) ?? { ...f, variants: [] }
    e.variants.push(variant)
    entry.findings.set(key, e)
    const g = rollup.get(f.rule) ?? { rule: f.rule, sev: f.sev, count: 0, screens: new Set(), samples: [] }
    g.count += 1
    g.screens.add(screen)
    if (g.samples.length < 4 && !g.samples.includes(f.detail)) g.samples.push(f.detail)
    rollup.set(f.rule, g)
  }
  screens.set(screen, entry)
}

const out = {
  steps: records.length,
  screens: [...screens.values()].map((s) => ({
    screen: s.screen,
    worst: Math.min(...s.variants.map((v) => v.score)),
    mean: Math.round(s.variants.reduce((a, v) => a + v.score, 0) / s.variants.length),
    variants: s.variants,
    findings: [...s.findings.values()].sort((a, b) => b.weight - a.weight),
  })).sort((a, b) => a.worst - b.worst),
  rollup: [...rollup.values()].map((g) => ({ ...g, screens: [...g.screens] })).sort((a, b) => b.count - a.count),
  axeTotals: records.reduce((acc, r) => { for (const [k, v] of Object.entries(r.axe?.counts ?? {})) acc[k] = (acc[k] ?? 0) + v; return acc }, {}),
}
fs.writeFileSync(path.join(dir, 'design-summary.json'), JSON.stringify(out, null, 2))

const md = []
md.push(`steps ${out.steps} · axe nodes ${JSON.stringify(out.axeTotals)}`, '')
md.push('| rule | sev | findings | screens | e.g. |', '|---|---|---|---|---|')
for (const g of out.rollup) md.push(`| ${g.rule} | ${g.sev} | ${g.count} | ${g.screens.length} | ${g.samples[0]?.replace(/\|/g, '\\|').slice(0, 160) ?? ''} |`)
md.push('', '| screen | worst | mean | variants | top findings |', '|---|---|---|---|---|')
for (const s of out.screens) {
  md.push(`| ${s.screen} | ${s.worst} | ${s.mean} | ${s.variants.length} | ${s.findings.slice(0, 3).map((f) => `${f.rule} (${f.variants.length})`).join('; ')} |`)
}
fs.writeFileSync(path.join(dir, 'design-summary.md'), md.join('\n'))
console.log(md.slice(0, 60).join('\n'))
