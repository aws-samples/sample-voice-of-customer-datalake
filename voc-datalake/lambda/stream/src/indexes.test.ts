/**
 * Guard test for the streaming Lambda's GSI-name mirror (issue #213).
 *
 * Parses lib/stacks/core-stack.ts (the single source of truth) and asserts
 * every constant declared here exists there, so a stack rename fails this
 * suite instead of the live API (#140 failure mode). The Python side has the
 * stricter full-set mirror test in lambda/shared/test/test_indexes.py.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FEEDBACK_BY_DATE_INDEX, FEEDBACK_BY_ID_INDEX } from './indexes.js'

function stackIndexNames(): Set<string> {
  // lambda/stream/src -> voc-datalake/lib/stacks/core-stack.ts
  // import.meta.url (not __dirname): this package is ESM/NodeNext.
  const stackPath = fileURLToPath(new URL('../../../lib/stacks/core-stack.ts', import.meta.url))
  const source = readFileSync(stackPath, 'utf-8')
  return new Set([...source.matchAll(/indexName:\s*'([^']+)'/g)].map((m) => m[1]))
}

describe('GSI name mirror (#213)', () => {
  it('parses index definitions out of core-stack.ts', () => {
    expect(stackIndexNames().size).toBeGreaterThanOrEqual(7)
  })

  it.each([
    ['FEEDBACK_BY_DATE_INDEX', FEEDBACK_BY_DATE_INDEX],
    ['FEEDBACK_BY_ID_INDEX', FEEDBACK_BY_ID_INDEX],
  ])('%s exists in the CDK stack', (_name, value) => {
    expect(stackIndexNames()).toContain(value)
  })
})
