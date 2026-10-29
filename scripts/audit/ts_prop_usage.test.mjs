import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { analyzePropUsage } from './ts_prop_usage.mjs'
import { fixtureProject, kinds } from './ts_audit_fixture.mjs'

// No React types in the fixture: the checker still resolves JSX tags to their declarations.
const COMPONENTS = `
type BadgeProps = { label: string; size?: 'sm' | 'md'; tone?: string; title?: string; children?: unknown }
export function Badge({ label, size = 'md', tone, title, children }: BadgeProps) { return [label, size, tone, title, children] }
export const Tile = ({ icon, hint }: { icon?: string; hint?: string }) => [icon, hint]
export function Spread({ a }: { a?: string }) { return a }
export function AsValue({ b }: { b?: string }) { return b }
export function Tick({ x }: { x?: number }) { return x }
export function Routed({ to }: { to?: string; children?: unknown }) { return to }
`
const USES = `
import { Badge, Tile, Spread, AsValue, Tick, Routed } from './components'
declare const Chart: (p: { tick?: unknown; element?: unknown }) => unknown
const rest = { a: 'x' }
export const page = [
  <Badge label="a" tone="t" />,
  <Badge label="b" tone="t">child</Badge>,
  <Badge label="c" tone="t" />,
  <Tile icon="i" />,
  <Spread {...rest} />,
  <Chart tick={<Tick />} />,
  <Chart element={<Routed><Badge label="d" tone="t" /></Routed>} />,
]
export const table = [AsValue]
`
const SPEC = `
import { Badge, Tile } from './components'
export const spec = [<Badge label="s" size="sm" />, <Tile icon="i" hint="h" />]
`

test('reports never-passed and test-only props; always-passed is advisory; spread, value, cloned and lazy components are skipped', () => {
  const fx = fixtureProject({
    'src/components.tsx': COMPONENTS,
    'src/main.tsx': USES,
    'src/main.test.tsx': SPEC,
    'src/lazy.tsx': "export default function LazyPage({ unused }: { unused?: string }) { return unused }\nfunction Local({ q }: { q?: string }) { return q }\nexport const l = [<Local />, <LazyPage />]\n",
    'src/router.ts': "export const load = () => import('./lazy')\n",
  }, { entries: [{ file: 'src/main.tsx', module: true }] })
  try {
    const { findings, advisory } = analyzePropUsage(fx.def)
    assert.deepEqual(kinds(findings), {
      'src/components.tsx#Badge.size': 'test-only-prop',
      'src/components.tsx#Badge.title': 'never-passed',
      'src/components.tsx#Routed.to': 'never-passed',
      'src/components.tsx#Tile.hint': 'test-only-prop',
      'src/lazy.tsx#Local.q': 'never-passed',
    })
    // tone: all 4 production sites pass it (advisory only); children: 1 of 4; Tile.icon: 1 site, under the advisory floor.
    assert.deepEqual(kinds(advisory), { 'src/components.tsx#Badge.tone': 'always-passed' })
  } finally {
    fx.cleanup()
  }
})
