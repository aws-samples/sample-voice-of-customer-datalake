import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { scanNameTwins } from './ts_name_twins.mjs'
import { kinds, tempTree } from './ts_audit_fixture.mjs'

const SPA = 'voc-datalake/frontend/src'
const STREAM = 'voc-datalake/lambda/stream/src'
const GUARD = "(value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)"

test('reports identical, near and exported same-name twins within a package; quiet on the look-alikes', () => {
  const dir = tempTree({
    [`${SPA}/lib/typeGuards.ts`]: `export const isRecord = ${GUARD}\nexport function clip(text: string, max: number) { return text.length > max ? text.slice(0, max) : text }\n`,
    [`${SPA}/pages/A/a.ts`]: `const isRecord = ${GUARD}\nexport const useThing = (v: string) => v\n`,
    [`${SPA}/pages/B/b.ts`]: 'export function format(items: string[], sep: string) { const out = items.filter(Boolean).map((i) => i.trim()); return out.join(sep) }\nfunction clip(n: number) { return Math.min(Math.max(n, 0), 1) }\n',
    [`${SPA}/pages/C/c.ts`]: 'export function format(list: string[], glue: string) { const kept = list.filter(Boolean).map((x) => x.trim()); return kept.join(glue).trim() }\n',
    [`${SPA}/pages/D/d.ts`]: 'export const Header = () => null\nexport function normalizeRow(v: unknown) { return v }\nconst local = (n: number) => n + 1\n',
    [`${SPA}/pages/E/e.ts`]: 'export const Header = () => 1\nexport function normalizeRow(v: unknown) { return [v] }\nconst local = (s: string) => s.repeat(2).toUpperCase().trim()\n',
    [`${SPA}/pages/A/a.test.ts`]: `const isRecord = ${GUARD}\n`,
    [`${STREAM}/x.ts`]: 'export const useThing = (v: string) => v\n',
  })
  try {
    const { findings, functions } = scanNameTwins(dir)
    assert.deepEqual(kinds(findings), {
      'frontend:isRecord': 'identical',
      'frontend:format': 'near',
      'frontend:clip': 'same-name',
    })
    assert.ok(functions >= 10)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
