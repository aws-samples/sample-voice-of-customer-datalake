/**
 * LOCKSTEP: the plan-mode approval boundary (./planSchemas) ⇄ the stream
 * Lambda's tool schemas (`lambda/stream/src/assistant/tools/client/scraper-schemas.ts`
 * for the source ids, `plan-writes.ts` for the prototype bounds). Constants are
 * read as TEXT, so un-exported ones count too, and compared in order: a source
 * the stream offers but the SPA refuses would be a card the user can never
 * approve, and a longer title on one side a write refused after approval.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { constNumberRecord, constStringList } from '@test/sourceLiterals'
import { buildPrototypeArgs, runSourceArgs, setSourceEnabledArgs } from './planSchemas'

const ROOT = join(__dirname, '../../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const spa = read('frontend/src/assistant/approvals/planSchemas.ts')
const streamSources = read('lambda/stream/src/assistant/tools/client/scraper-schemas.ts')
const streamPlanWrites = read('lambda/stream/src/assistant/tools/client/plan-writes.ts')

describe('plan-mode tool bounds: stream ⇄ SPA', () => {
  it('run_source accepts exactly the stream\u2019s sources, in the same order', () => {
    const stream = constStringList(streamSources, 'RUN_SOURCE_IDS')
    expect(constStringList(spa, 'RUN_SOURCE_IDS')).toStrictEqual(stream)
    expect(runSourceArgs.shape.source.options).toStrictEqual(stream)
  })

  it('set_source_enabled accepts exactly the stream\u2019s scheduled sources, in the same order', () => {
    const stream = constStringList(streamSources, 'SCHEDULED_SOURCE_IDS')
    expect(constStringList(spa, 'SCHEDULED_SOURCE_IDS')).toStrictEqual(stream)
    expect(setSourceEnabledArgs.shape.source.options).toStrictEqual(stream)
  })

  it('build_prototype has the stream\u2019s title and feedback bounds', () => {
    const limits = constNumberRecord(streamPlanWrites, 'PROTOTYPE_LIMITS')
    expect(constNumberRecord(spa, 'BUILD_PROTOTYPE_LIMITS')).toStrictEqual(limits)
    // Parsed rather than indexed, so a renamed key fails here instead of reading as 0.
    const { titleChars, feedbackChars } = z.object({ titleChars: z.number(), feedbackChars: z.number() }).parse(limits)
    const args = (title: string, feedback: string) => buildPrototypeArgs.safeParse({ project_id: 'proj_1', title, feedback }).success
    expect(args('t'.repeat(titleChars), 'f'.repeat(feedbackChars))).toBe(true)
    expect(args('t'.repeat(titleChars + 1), 'f')).toBe(false)
    expect(args('t', 'f'.repeat(feedbackChars + 1))).toBe(false)
  })
})
