import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { scanStaleRefs, sentences } from './ts_stale_refs.mjs'
import { kinds, tempTree } from './ts_audit_fixture.mjs'

const SPA = 'voc-datalake/frontend/src'

test('reports a false pin, a missing file and a missing identifier; quiet on the look-alikes', () => {
  const dir = tempTree({
    [`${SPA}/api/limits.ts`]: [
      '/** `lambda/shared/limits.py` — pinned by limits.lockstep.test.ts. */',
      'export const LIMITS = 1',
      '// The writer lives in lambda/shared/gone_writer.py and calls `writeTheThing`.',
      '// Same shape as `realHelper` in ./helper.ts (and helper.js as an ESM specifier).',
      '// It was in old/place.ts once; `renamedAway` was its old name.',
      '// Runs on Node.js 22; see https://example.com/docs/page.md for more.',
      '// There is deliberately no `MustNotExist` companion.',
      '// Plural forms: `itemCount_one` is reached through its base.',
      'export const itemCount = 2',
    ].join('\n'),
    [`${SPA}/api/helper.ts`]: 'export function realHelper() { return 1 }\n',
    [`${SPA}/api/helper.test.ts`]: '// `notInCodeAnywhere` is fine in a spec; the file pinned by it is helper.ts.\n',
    'voc-datalake/lambda/shared/limits.py': 'MAX = 1\n',
    'voc-datalake/frontend/mock-thing.js': '// Mirrors lambda/api/moved_away.py.\nexport const x = 1\n',
  })
  try {
    const { findings, counts } = scanStaleRefs(dir)
    assert.deepEqual(kinds(findings), {
      [`${SPA}/api/limits.ts::limits.lockstep.test.ts`]: 'missing-test',
      [`${SPA}/api/limits.ts::lambda/shared/gone_writer.py`]: 'missing-file',
      [`${SPA}/api/limits.ts::writeTheThing`]: 'missing-identifier',
      'voc-datalake/frontend/mock-thing.js::lambda/api/moved_away.py': 'missing-file',
    })
    assert.ok(counts.paths >= 6 && counts.idents >= 5, JSON.stringify(counts))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a comment splits into sentences that keep their first line', () => {
  const out = sentences({ line: 10, text: '/**\n * First one. Second\n * wraps here.\n *\n * Third.\n */' })
  assert.deepEqual(out, [{ text: 'First one.', line: 11 }, { text: 'Second wraps here.', line: 11 }, { text: 'Third.', line: 14 }])
})
