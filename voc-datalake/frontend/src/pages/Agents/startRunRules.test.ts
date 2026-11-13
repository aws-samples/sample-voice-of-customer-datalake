/**
 * @fileoverview A run's start rules: what each field takes and the request it builds, and the
 * LOCKSTEP with the server, read as text (`lambda/api/agents_handler.py` MAX_RUN_GOAL, `runtime/interface.py`
 * MAX_ID_LENGTH, the stack's IMAGE_LANGUAGES, which a Python test holds to the runtime's REGISTRY_HOSTS): a field the
 * form lets through and the server refuses would be a start that fails after Start.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiError, AuthError } from '../../lib/errors'
import {
  MAX_CONNECTION_ID, MAX_RUN_GOAL, RUN_LANGUAGES, startOutcomeOf, startRunIssues, startRunRequest,
} from './startRunRules'
import type { StartRunForm } from './startRunRules'

const ROOT = join(__dirname, '../../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const FORM: StartRunForm = { connection: 'conn-1', commit: COMMIT, language: 'python', goal: 'Fix it' }

/** The number a `NAME = 123` or `NAME: Final = 123` line sets in `source`. */
function pythonNumber(source: string, name: string): number {
  const match = new RegExp(`^${name}(?:: Final)? = ([\\d_]+)$`, 'm').exec(source)
  if (match?.[1] === undefined) throw new Error(`${name} not found`)
  return Number(match[1].replaceAll('_', ''))
}

describe('the start rules: form ⇄ server', () => {
  it('bound the goal and the connection id as the server does', () => {
    expect(pythonNumber(read('lambda/api/agents_handler.py'), 'MAX_RUN_GOAL')).toBe(MAX_RUN_GOAL)
    expect(pythonNumber(read('lambda/engineering/runtime/interface.py'), 'MAX_ID_LENGTH')).toBe(MAX_CONNECTION_ID)
  })

  it('offer exactly the languages with an image', () => {
    const match = /const IMAGE_LANGUAGES = \[([^\]]*)\]/.exec(read('lib/stacks/engineering-runtime.ts'))
    const stack = [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(stack).toStrictEqual([...RUN_LANGUAGES])
  })
})

describe('startRunIssues', () => {
  it('passes a good form', () => {
    expect(startRunIssues(FORM)).toStrictEqual({})
    expect(startRunIssues({ ...FORM, connection: 'c'.repeat(63), commit: ` ${COMMIT.toUpperCase()} `, goal: 'é'.repeat(500) }))
      .toStrictEqual({})
  })

  it.each([
    [{ connection: '' }, { connection: 'connection' }],
    [{ connection: 'c'.repeat(64) }, { connection: 'connection' }],
    [{ connection: 'conn_1' }, { connection: 'connection' }],
    [{ commit: COMMIT.slice(1) }, { commit: 'commit' }],
    [{ commit: `${COMMIT}${'a'.repeat(24)}` }, { commit: 'commit' }],
    [{ commit: 'g'.repeat(40) }, { commit: 'commit' }],
    [{ goal: ' \n ' }, { goal: 'goalEmpty' }],
    [{ goal: 'x'.repeat(501) }, { goal: 'goalLong' }],
    // (counted in characters: 500 emoji are 500, not 1,000 UTF-16 units)
    [{ goal: '🙂'.repeat(501) }, { goal: 'goalLong' }],
  ])('says what is wrong (%o)', (change, issues) => {
    expect(startRunIssues({ ...FORM, ...change })).toStrictEqual(issues)
  })

  it('counts a goal of 500 emoji as 500 characters', () => {
    expect(startRunIssues({ ...FORM, goal: '🙂'.repeat(500) })).toStrictEqual({})
  })
})

describe('startOutcomeOf', () => {
  const RUN = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'
  const OTHER = '01JD3R4NZXQ7Y2W8K4M6P9T0CD'
  const named = (runId: string) => ({ kind: 'named', runId })
  const unknown = { kind: 'unknown' }

  it('names the run the body names first, else the one a 503\'s message names', () => {
    expect([
      startOutcomeOf(new ApiError(503, `run ${OTHER} may have been started`, RUN)),
      startOutcomeOf(new ApiError(503, `run ${RUN} may have been started: open the run monitor`)),
    ]).toStrictEqual([named(RUN), named(RUN)])
  })

  it('counts a 504, a 5xx with no reason of its own, a network failure or an unreadable answer as may have started', () => {
    expect([
      startOutcomeOf(new ApiError(504, 'Endpoint request timed out')),
      startOutcomeOf(new ApiError(502)),
      startOutcomeOf(new TypeError('Failed to fetch')),
      startOutcomeOf(new SyntaxError('Unexpected token < in JSON')),
      startOutcomeOf(new Error('The start answer was unreadable')),
    ]).toStrictEqual([unknown, unknown, unknown, unknown, unknown])
  })

  it('leaves the server\'s own answers and an ended sign-in to say what to do', () => {
    expect([
      startOutcomeOf(new ApiError(503, 'the run could not be started: start it again')),
      startOutcomeOf(new ApiError(409, `run ${RUN} is not active`)),
      startOutcomeOf(new ApiError(400, 'commit is a full commit id')),
      startOutcomeOf(new AuthError()),
    ]).toStrictEqual([null, null, null, null])
  })
})

describe('startRunRequest', () => {
  it('trims, lower-cases the commit and puts the goal on one line', () => {
    expect(startRunRequest('wf_1', { connection: ' conn-1 ', commit: COMMIT.toUpperCase(), language: 'rust',
      goal: ' Fix\n the   bug ' })).toStrictEqual({
      workflow_id: 'wf_1', connection: 'conn-1', commit: COMMIT, language: 'rust', goal: 'Fix the bug',
    })
  })
})
