/**
 * LOCKSTEP: the draft_prototype_revision approval boundary (./prototypeSchemas) ⇄ the stream Lambda's
 * declaration (`lambda/stream/src/assistant/tools/client/prototype-draft.ts`). The stream's bounds are read as
 * TEXT (that module is server code, not in the browser bundle): an instruction or a pin list the stream accepts
 * but the card refuses would be a card the user can never approve, and the reverse a write refused after approval.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { constNumberRecord } from '@test/sourceLiterals'
import { draftPrototypeRevisionArgs } from './prototypeSchemas'

const ROOT = join(__dirname, '../../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const spa = read('frontend/src/assistant/approvals/prototypeSchemas.ts')
const stream = read('lambda/stream/src/assistant/tools/client/prototype-draft.ts')

/** The stream's `export const <name> = <n>;`. */
function streamBound(name: string): number {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(stream)
  if (match?.[1] === undefined) throw new Error(`${name} not found in the stream tool`)
  return Number(match[1])
}

const base = { project_id: 'proj_1', document_id: 'proto_1' }
const pinId = (n: number) => `pin_${String(n).padStart(20, '0')}abcdef`
const ok = (args: Record<string, unknown>) => draftPrototypeRevisionArgs.safeParse({ ...base, ...args }).success

describe('draft_prototype_revision bounds: stream ⇄ SPA', () => {
  it('has the stream’s instruction and pin bounds', () => {
    expect(constNumberRecord(spa, 'DRAFT_PROTOTYPE_LIMITS'))
      .toStrictEqual({ instructionChars: streamBound('MAX_DRAFT_INSTRUCTION_CHARS'), pins: streamBound('MAX_DRAFT_PINS') })
  })

  it('admits an instruction exactly up to the stream’s bound', () => {
    const bound = streamBound('MAX_DRAFT_INSTRUCTION_CHARS')
    expect([ok({ instruction: 'x'.repeat(bound) }), ok({ instruction: 'x'.repeat(bound + 1) })]).toStrictEqual([true, false])
  })

  it('admits pin ids exactly up to the stream’s bound, and exactly one of instruction / pin_ids', () => {
    const bound = streamBound('MAX_DRAFT_PINS')
    const pins = (count: number) => Array.from({ length: count }, (_, index) => pinId(index))
    expect([ok({ pin_ids: pins(bound) }), ok({ pin_ids: pins(bound + 1) }), ok({ pin_ids: [] })]).toStrictEqual([true, false, false])
    expect([ok({}), ok({ instruction: 'x', pin_ids: pins(1) })]).toStrictEqual([false, false])
    expect(stream).toMatch(/required: \['project_id', 'document_id'\]/)
  })

  it('set_prototype_walkthrough has the stream tool’s bounds (and so the route’s)', () => {
    const walkthrough = read('lambda/stream/src/assistant/tools/client/prototype-walkthrough.ts')
    const stream = constNumberRecord(walkthrough, 'WALKTHROUGH_LIMITS')
    expect(constNumberRecord(read('frontend/src/api/prototypeWalkthroughSchema.ts'), 'WALKTHROUGH_LIMITS')).toStrictEqual({
      steps: stream.steps, title: stream.titleChars, body: stream.bodyChars, selector: stream.selectorChars, route: stream.routeChars,
    })
  })

  it('checks each pin id with the stream’s own id rule (both sides: an idSchema list), the format left to the route', () => {
    expect(stream).toMatch(/pin_ids: z\.array\(idSchema\)/)
    expect(spa).toMatch(/z\.array\(idSchema\)/)
    expect([ok({ pin_ids: ['pin_odd_but_plain'] }), ok({ pin_ids: ['../x'] })]).toStrictEqual([true, false])
  })
})
