/**
 * LOCKSTEP: the draft_prototype_revision approval boundary (./prototypeSchemas) ⇄ the stream Lambda's
 * declaration (`lambda/stream/src/assistant/tools/client/prototype-draft.ts`). The stream's bound is read as
 * TEXT (that module is server code, not in the browser bundle): an instruction the stream accepts but the
 * card refuses would be a card the user can never approve, and the reverse a write refused after approval.
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

/** The stream's `export const MAX_DRAFT_INSTRUCTION_CHARS = <n>;`. */
function streamBound(): number {
  const match = /export const MAX_DRAFT_INSTRUCTION_CHARS = (\d+);/.exec(stream)
  if (match?.[1] === undefined) throw new Error('MAX_DRAFT_INSTRUCTION_CHARS not found in the stream tool')
  return Number(match[1])
}

describe('draft_prototype_revision bounds: stream ⇄ SPA', () => {
  it('has the stream’s instruction bound, and admits exactly up to it', () => {
    const bound = streamBound()
    expect(constNumberRecord(spa, 'DRAFT_PROTOTYPE_LIMITS')).toStrictEqual({ instructionChars: bound })
    const ok = (instruction: string) => draftPrototypeRevisionArgs.safeParse({ project_id: 'proj_1', document_id: 'proto_1', instruction }).success
    expect([ok('x'.repeat(bound)), ok('x'.repeat(bound + 1))]).toStrictEqual([true, false])
  })

  it('takes the same three fields as the stream, all required', () => {
    expect(Object.keys(draftPrototypeRevisionArgs.shape)).toStrictEqual(['project_id', 'document_id', 'instruction'])
    expect(stream).toMatch(/required: \['project_id', 'document_id', 'instruction'\]/)
  })
})
