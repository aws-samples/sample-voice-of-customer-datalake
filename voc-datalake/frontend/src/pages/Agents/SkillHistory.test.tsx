/**
 * @fileoverview Agents → Skills → a role's history: its versions newest first, each with its status, why, who and
 * when, its events and its benchmark (measured apart from claimed); the next page on request; empty, loading and
 * failed states; a version opening its detail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { SkillHistory } = await import('./SkillHistory')

const FIRST_PAGE = 'GET /agents/engineering/skills/fixer/versions?connection=storefront'
const AT = '2026-11-10T09:00:00Z'

const line = (version: number, fields: Record<string, unknown> = {}) => ({
  version, status: 'accepted', summary: `Fixer skill proposed: v${String(version)}`, why: { run_id: '', failure: '', comment: 'A clearer rule.' },
  proposed_by: 'admin-sub', proposed_by_kind: 'person', proposed_at: AT, accepted_by: 'admin-sub', accepted_at: AT,
  rejected_by: '', rejected_at: '', restores: 0, base: null, benchmark: { claimed: null, measured: null }, expected_case: '',
  events: [], ...fields,
})
const MEASURED = {
  before: 0.5, after: 1, passed: true, gained: true, failure_case: 'slug-cut-bug', cases: 4, reasons: [], by: 'admin-sub', at: AT,
}

function renderHistory(routes: Record<string, RouteHandler>, onOpen = vi.fn<(version: number) => void>()) {
  routeFetchApi(routes, { missStatus: 500 })
  renderWithQueryClient(<SkillHistory connection="storefront" role="fixer" onOpen={onOpen} />)
  return onOpen
}

beforeEach(() => { resetFetchApi() })

describe('Agents → Skills: a role\'s history', () => {
  it('shows each version newest first with its status, why and events', async () => {
    renderHistory({ [FIRST_PAGE]: () => ({ current_version: 1, next_page: null, versions: [
      line(2, { status: 'rejected', events: [{ event: 'rejected', by: 'admin-sub', at: AT, comment: 'Too strict.' }] }), line(1)] }) })
    const opens = await screen.findAllByRole('button', { name: /^Open version/ })
    expect(opens.map((button) => button.textContent)).toStrictEqual(['Version 2', 'Version 1'])
    expect(screen.getByText('Rejected')).toBeInTheDocument()
    expect(screen.getByText('Too strict.')).toBeInTheDocument()
  })

  it('shows a measured benchmark apart from a proposer\'s claim, labelled as each', async () => {
    renderHistory({ [FIRST_PAGE]: () => ({ current_version: 1, next_page: null, versions: [
      line(2, { benchmark: { measured: MEASURED, claimed: { before: 0.4, after: 0.9 } } })] }) })
    expect(await screen.findByText('Measured')).toBeInTheDocument()
    expect(screen.getByText('Claimed')).toBeInTheDocument()
    expect(screen.getByText('given by the proposer, not measured')).toBeInTheDocument()
    expect(screen.getByText(/pass rate 50% → 100%/)).toBeInTheDocument()
  })

  it('names the coach as the proposer of its version, with the run it learned from', async () => {
    renderHistory({ [FIRST_PAGE]: () => ({ current_version: 0, next_page: null, versions: [
      line(1, { status: 'proposed', proposed_by: 'coach-0', proposed_by_kind: 'agent', why: { run_id: '01JDA7K3M9Q2R5T8V0W4X6Y1Z3', failure: 'no_go', comment: '' } })] }) })
    expect(await screen.findByText(/Proposed by the coach \(coach-0\)/)).toBeInTheDocument()
    expect(screen.getByText(/From run 01JDA7K3M9Q2R5T8V0W4X6Y1Z3 \(no_go\)/)).toBeInTheDocument()
  })

  it('reads the next page with the server\'s token when asked', async () => {
    renderHistory({
      [FIRST_PAGE]: () => ({ current_version: 2, next_page: 'tok_next', versions: [line(2)] }),
      [`${FIRST_PAGE}&page=tok_next`]: () => ({ current_version: 2, next_page: null, versions: [line(1)] }),
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Load older versions' }))
    expect(await screen.findByRole('button', { name: 'Open version 1 and its changes' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load older versions' })).not.toBeInTheDocument()
  })

  it('opens a version\'s detail', async () => {
    const onOpen = renderHistory({ [FIRST_PAGE]: () => ({ current_version: 2, next_page: null, versions: [line(2)] }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Open version 2 and its changes' }))
    expect(onOpen).toHaveBeenCalledWith(2)
  })

  it('says a role with no versions has none', async () => {
    renderHistory({ [FIRST_PAGE]: () => ({ current_version: 0, next_page: null, versions: [] }) })
    expect(await screen.findByText('This role has no versions in this scope.')).toBeInTheDocument()
  })

  it('says a failed read failed, with a retry', async () => {
    renderHistory({})
    expect(await screen.findByRole('alert')).toHaveTextContent('The history could not be loaded. Try again in a moment.')
  })
})
