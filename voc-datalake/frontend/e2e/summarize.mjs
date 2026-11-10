#!/usr/bin/env node
/**
 * Summarizes an e2e evidence directory: step verdicts, API latency p50/p95 per
 * endpoint (from browser calls), axe totals by impact and rule, console errors,
 * off-palette colours and focus checks. Writes summary.json next to the input
 * and prints a compact text version.
 * Usage: node e2e/summarize.mjs <E2E_OUT>
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? path.resolve('e2e-output')
const stepsDir = path.join(dir, 'steps')
const steps = fs.readdirSync(stepsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(stepsDir, f), 'utf8')))

const pct = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
const normalize = (p) => p
  .replace(/\/v1/, '')
  .replace(/\/(proj|ag|wf|pf|ff|scraper|tok|mcpg)_[A-Za-z0-9_]+/g, '/{id}')
  .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '/{id}')
  .replace(/\/[A-Za-z0-9_-]{20,}/g, '/{id}')

const latency = new Map()
const statuses = new Map()
const axeRules = new Map()
const axeImpact = {}
const consoleErrors = []
const offPalette = new Map()
const focusFails = []
const emojis = []

for (const s of steps) {
  for (const c of s.calls) {
    if (!c.host.includes('execute-api')) continue
    const key = `${c.method} ${normalize(c.path)}`
    if (c.durationMs !== null) latency.set(key, [...(latency.get(key) ?? []), c.durationMs])
    const st = statuses.get(key) ?? {}
    st[String(c.status ?? c.failure)] = (st[String(c.status ?? c.failure)] ?? 0) + 1
    statuses.set(key, st)
  }
  for (const v of s.axe?.violations ?? []) {
    const k = `${v.impact}|${v.id}`
    const e = axeRules.get(k) ?? { impact: v.impact, id: v.id, help: v.help, nodes: 0, screens: new Set(), targets: new Set() }
    e.nodes += v.nodes
    e.screens.add(`${s.role}-${s.theme}-${s.step}`)
    v.targets.forEach((t) => e.targets.size < 6 && e.targets.add(t))
    axeRules.set(k, e)
    axeImpact[v.impact] = (axeImpact[v.impact] ?? 0) + v.nodes
  }
  for (const c of s.console) if (c.type === 'error') consoleErrors.push({ step: `${s.role}-${s.theme}-${s.step}`, text: c.text })
  for (const o of s.design?.offPalette ?? []) {
    const k = `${s.theme}|${o.property}|${o.color}`
    const e = offPalette.get(k) ?? { theme: s.theme, property: o.property, color: o.color, count: 0, samples: new Set(), screens: new Set() }
    e.count += o.count
    e.samples.size < 3 && e.samples.add(o.sample)
    e.screens.add(s.step)
    offPalette.set(k, e)
  }
  for (const f of s.design?.focus ?? []) if (!f.visible) focusFails.push({ step: `${s.role}-${s.theme}-${s.step}`, ...f })
  if ((s.design?.emojis ?? []).length > 0) emojis.push({ step: `${s.role}-${s.theme}-${s.step}`, emojis: s.design.emojis })
}

const endpoints = [...latency.entries()].map(([k, v]) => ({ endpoint: k, n: v.length, p50: pct(v, 50), p95: pct(v, 95), max: Math.max(...v), statuses: statuses.get(k) }))
  .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0))
const nav = steps.filter((s) => s.navigation?.domContentLoadedMs).map((s) => s.navigation.domContentLoadedMs)
const summary = {
  steps: steps.length,
  passed: steps.filter((s) => s.ok).length,
  failed: steps.filter((s) => !s.ok).map((s) => ({ step: `${s.role}-${s.theme}-${s.step}`, error: s.error, screenshot: s.screenshot })),
  navigation: { n: nav.length, domContentLoadedP50: pct(nav, 50), domContentLoadedP95: pct(nav, 95) },
  stepWall: { p50: pct(steps.map((s) => s.wallMs), 50), p95: pct(steps.map((s) => s.wallMs), 95) },
  endpoints,
  axeImpact,
  axeRules: [...axeRules.values()].map((e) => ({ ...e, screens: [...e.screens], targets: [...e.targets] })).sort((a, b) => b.nodes - a.nodes),
  consoleErrors,
  offPalette: [...offPalette.values()].map((e) => ({ ...e, samples: [...e.samples], screens: [...e.screens] })).sort((a, b) => b.count - a.count),
  focusFails,
  emojis,
}
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2))

console.log(`steps ${summary.steps} passed ${summary.passed} failed ${summary.failed.length}`)
for (const f of summary.failed) console.log(`  FAIL ${f.step}: ${String(f.error).slice(0, 220)}`)
console.log(`navigation DCL p50 ${summary.navigation.domContentLoadedP50}ms p95 ${summary.navigation.domContentLoadedP95}ms; step wall p50 ${summary.stepWall.p50}ms p95 ${summary.stepWall.p95}ms`)
console.log('slowest endpoints (browser):')
for (const e of endpoints.slice(0, 25)) console.log(`  ${e.endpoint}  n=${e.n} p50=${e.p50} p95=${e.p95} max=${e.max} ${JSON.stringify(e.statuses)}`)
console.log('axe by impact (nodes):', JSON.stringify(axeImpact))
for (const r of summary.axeRules.slice(0, 20)) console.log(`  ${r.impact} ${r.id} nodes=${r.nodes} screens=${r.screens.length} e.g. ${r.screens.slice(0, 3).join(',')} :: ${r.targets.slice(0, 2).join(' | ')}`)
console.log(`console errors: ${consoleErrors.length}`)
for (const c of consoleErrors.slice(0, 15)) console.log(`  ${c.step}: ${c.text.slice(0, 200)}`)
console.log('off-palette colours:')
for (const o of summary.offPalette.slice(0, 15)) console.log(`  ${o.theme} ${o.property} ${o.color} x${o.count} on ${o.screens.length} screens e.g. ${o.samples[0]}`)
console.log(`focus without visible indicator: ${focusFails.length}`)
for (const f of focusFails.slice(0, 10)) console.log(`  ${f.step}: ${f.element} ${f.detail}`)
console.log(`emoji screens: ${emojis.length}`, JSON.stringify(emojis.slice(0, 10)))
