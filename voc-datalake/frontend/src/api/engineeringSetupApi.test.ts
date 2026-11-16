/**
 * @fileoverview The setup guide's progress as the SPA reads it (api/engineeringSetupApi.ts): every step, an unknown
 * state as nothing chosen, an answer without its steps or revision an error; the steps, their states and the intro in
 * step with the route that stores them (lambda/shared/agents_engineering_setup_routes.py).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETUP_STEP_IDS, parseSetupProgress } from './engineeringSetupApi'

const ROUTES = readFileSync(join(__dirname, '../../../lambda/shared/agents_engineering_setup_routes.py'), 'utf8')

/** The strings of a `NAME: Final = ('a', 'b')` tuple of the route module. */
const pyTuple = (name: string): string[] => {
  const body = new RegExp(`^${name}: Final = \\(([^)]*)\\)`, 'm').exec(ROUTES)?.[1] ?? ''
  return [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? '')
}

const NOTHING = Object.fromEntries(SETUP_STEP_IDS.map((step) => [step, 'pending']))

describe('the setup progress', () => {
  it('names the steps, states and intros the route stores', () => {
    expect(pyTuple('STEP_IDS')).toStrictEqual([...SETUP_STEP_IDS])
    expect(pyTuple('STEP_STATES')).toStrictEqual(['pending', 'skipped', 'done'])
    expect(pyTuple('INTROS')).toStrictEqual(['unseen', 'started', 'skipped'])
  })

  it('reads every step, an unknown state or intro as nothing chosen', () => {
    const progress = parseSetupProgress({
      steps: { triage: 'skipped', ready: 'done', bug_fixer: 'maybe', gone: 'done' }, intro: 'later', revision: 4,
      updated_at: '2026-11-16T12:00:00+00:00', updated_by: 'alice',
    })
    expect(progress).toStrictEqual({
      steps: { ...NOTHING, triage: 'skipped', ready: 'done' }, intro: 'unseen', revision: 4,
      updatedAt: '2026-11-16T12:00:00+00:00', updatedBy: 'alice',
    })
  })

  it.each([
    ['no steps', { intro: 'unseen', revision: 0 }],
    ['no revision', { steps: {}, intro: 'unseen' }],
    ['a negative revision', { steps: {}, revision: -1 }],
    ['not an object', 'nothing'],
  ])('refuses an answer with %s', (_name, raw) => {
    expect(() => parseSetupProgress(raw)).toThrow('The setup guide answer was unreadable')
  })
})
