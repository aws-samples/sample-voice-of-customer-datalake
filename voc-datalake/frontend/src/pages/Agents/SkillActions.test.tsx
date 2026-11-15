/**
 * @fileoverview Agents → Skills → a version's actions: each approval card says what changes and sends what the screen
 * showed with the reason; Accept held back for a coach's version without a passing benchmark; Roll back only on an
 * earlier accepted version; the Record benchmark form (prefilled, checked, converted); a 409 said as "it changed since
 * you opened it", and another refusal in the server's words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { SkillVersionDetail } from '../../api/engineeringSkillsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { SkillActions } = await import('./SkillActions')

const AT = '2026-11-10T09:00:00Z'
const BASE = '/agents/engineering/skills/fixer/versions/2'
const NO_DIFF = { instructions: [], examples: [], tools_added: [], tools_removed: [], tools_reordered: false, model: null, harness: null, first: false }
const MEASURED = { before: 0.5, after: 1, passed: true, gained: true, failure_case: 'slug-cut-bug', cases: 2, reasons: [], run_ref: '', by: 'admin-sub', at: AT }

const detail = (fields: Partial<SkillVersionDetail> = {}): SkillVersionDetail => ({
  version: 2, status: 'proposed', summary: 'Fixer skill proposed: v1 → v2, one more instruction line',
  why: { run_id: '', failure: '', comment: 'Stricter.' }, proposed_by: 'admin-sub', proposed_by_kind: 'person',
  proposed_at: AT, accepted_by: '', accepted_at: '', rejected_by: '', rejected_at: '', restores: 0,
  base: { shared: true, version: 1 }, benchmark: { claimed: null, measured: null }, expected_case: '', events: [],
  record: { instructions: 'Fix it.', examples: [], tool_policy: ['run'], model: 'model-a', harness: 'converse' },
  diff: NO_DIFF, made_with: null, ...fields,
})
const answer = () => ({ connection: '', role: 'fixer', version: { ...detail(), status: 'accepted' }, event: null })
const coach = (fields: Partial<SkillVersionDetail> = {}) =>
  detail({ proposed_by: 'coach-0', proposed_by_kind: 'agent', expected_case: 'slug-cut-bug', ...fields })

function renderActions(target: SkillVersionDetail, routes: Record<string, RouteHandler> = {}, current = 1,
  scope = { connection: '', sharedCurrent: 0 }) {
  routeFetchApi(routes, { missStatus: 500 })
  renderWithQueryClient(<SkillActions target={{ ...scope, role: 'fixer', detail: target, current }} />)
}

/** Each request sent: its path and its JSON body. */
const sent = (): [string, unknown][] => fetchApi.mock.calls.map(([path, init]) => {
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  return [path, body]
})

beforeEach(() => { resetFetchApi() })

describe('Agents → Skills: a version\'s approval cards', () => {
  it('says what accepting changes, then sends what the screen showed with the reason', async () => {
    renderActions(detail(), { [`POST ${BASE}/accept?connection=`]: answer })
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    const card = screen.getByRole('dialog', { name: 'Accept version 2?' })
    expect(within(card).getByText('The current version of this scope moves from v1 to v2.')).toBeInTheDocument()
    await userEvent.type(within(card).getByRole('textbox', { name: 'Reason (optional)' }), 'Clearer tests.')
    await userEvent.click(within(card).getByRole('button', { name: 'Accept version' }))
    expect(sent()).toStrictEqual([[`${BASE}/accept?connection=`,
      { expected_status: 'proposed', expected_current: 1, reason: 'Clearer tests.' }]])
  })

  it('rejects with the status the screen showed', async () => {
    renderActions(detail(), { [`POST ${BASE}/reject?connection=`]: answer })
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(screen.getByText(/Version 2 stays in the history, marked rejected/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reject version' }))
    expect(sent()).toStrictEqual([[`${BASE}/reject?connection=`, { expected_status: 'proposed' }]])
  })

  it('holds Accept back for a coach\'s version with no record of a benchmark run, focusable and saying why', async () => {
    renderActions(coach())
    const accept = screen.getByRole('button', { name: 'Accept' })
    expect(accept).toHaveAttribute('aria-disabled', 'true')
    expect(accept).toHaveAccessibleDescription(/accepted only once an administrator’s record of a benchmark run/)
    await userEvent.click(accept)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names what a connection with no version of its own runs, and flags a base that is not it', async () => {
    renderActions(detail(), {}, 0, { connection: 'conn-harbor', sharedCurrent: 3 })
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    const card = screen.getByRole('dialog', { name: 'Accept version 2?' })
    expect(within(card).getByText('The current version of this scope moves from shared v3 to this connection’s v2.')).toBeInTheDocument()
    expect(within(card).getByText('Written on shared v1.')).toBeInTheDocument()
    expect(within(card).getByRole('note')).toHaveTextContent('Its base is not the version in use now (shared v3)')
  })

  it('flags nothing when the base is the version in use', async () => {
    renderActions(detail(), {}, 0, { connection: 'conn-harbor', sharedCurrent: 1 })
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(within(screen.getByRole('dialog')).queryByRole('note')).not.toBeInTheDocument()
  })

  it('shows a coach\'s benchmark on its approval card once it passed with a gain', async () => {
    renderActions(coach({ benchmark: { claimed: null, measured: MEASURED } }))
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(within(screen.getByRole('dialog')).getByText(/pass rate 50% → 100%/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record benchmark' })).not.toBeInTheDocument()
  })

  it('offers Roll back on an earlier accepted version only, saying what it replaces', async () => {
    renderActions(detail({ status: 'accepted' }), {}, 3)
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Roll back to this version' }))
    expect(screen.getByText(/becomes current in place of v3/)).toBeInTheDocument()
  })

  it('offers nothing on the current version', () => {
    renderActions(detail({ status: 'accepted' }), {}, 2)
    expect(screen.queryByRole('group', { name: 'Actions on this version' })).not.toBeInTheDocument()
  })
})

describe('Agents → Skills: an action that the server refuses', () => {
  it('says it changed since it was opened on a 409, and holds the confirmation', async () => {
    const moved = 'it changed since you opened it: the current version was v1 and is v3 now; read it again'
    renderActions(detail(), { [`POST ${BASE}/accept?connection=`]: () => { throw new ApiError(409, moved) } })
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await userEvent.click(screen.getByRole('button', { name: 'Accept version' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('It changed since you opened it.')
    expect(screen.getByRole('button', { name: 'Accept version' })).toBeDisabled()
  })

  it('says the store\'s own 409 in its words, and leaves the confirmation on', async () => {
    const base = 'version 2 was written on v1, and v3 is current now: propose it again on the current version'
    renderActions(detail(), { [`POST ${BASE}/accept?connection=`]: () => { throw new ApiError(409, base) } })
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await userEvent.click(screen.getByRole('button', { name: 'Accept version' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(`The action was refused: ${base}`)
    expect(screen.getByRole('button', { name: 'Accept version' })).toBeEnabled()
  })

  it('says another refusal in the server\'s words', async () => {
    renderActions(detail(), { [`POST ${BASE}/reject?connection=`]: () => { throw new ApiError(400, 'reason is text of at most 2000 characters') } })
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reject version' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The action was refused: reason is text of at most 2000 characters')
  })
})

describe('Agents → Skills: the Record benchmark form', () => {
  it('prefills a coach\'s expected case and says what to fix first', async () => {
    renderActions(coach())
    await userEvent.click(screen.getByRole('button', { name: 'Record benchmark' }))
    expect(screen.getByRole('textbox', { name: 'Failure’s case' })).toHaveValue('slug-cut-bug')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record benchmark' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Give both pass rates as numbers from 0 to 100.')
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('sends the rates as fractions, the cases and reasons as lists', async () => {
    renderActions(coach(), { [`POST ${BASE}/benchmark?connection=`]: answer })
    await userEvent.click(screen.getByRole('button', { name: 'Record benchmark' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Pass rate before (%)' }), '50')
    await userEvent.type(screen.getByRole('textbox', { name: 'Pass rate after (%)' }), '100')
    await userEvent.type(screen.getByRole('textbox', { name: 'Cases (one per line or comma)' }), ', pagination-review')
    await userEvent.click(screen.getByRole('checkbox', { name: 'The gate passed' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Reasons (one per line)' }), 'slug-cut-bug gained')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Record benchmark' }))
    expect(sent()).toStrictEqual([[`${BASE}/benchmark?connection=`, {
      expected_status: 'proposed', before: 0.5, after: 1, cases: ['slug-cut-bug', 'pagination-review'], passed: true,
      reasons: ['slug-cut-bug gained'], failure_case: 'slug-cut-bug' }]])
  })
})
