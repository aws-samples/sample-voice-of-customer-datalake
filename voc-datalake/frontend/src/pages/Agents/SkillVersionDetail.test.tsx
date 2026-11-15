/**
 * @fileoverview Agents → Skills → one version: its diff as plain lines added and removed (said to a screen reader as
 * such), text from the record never read as HTML, its base and how it was made, a version not in the scope, a failed
 * read, and the way back to the history.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { SkillVersionDetail } = await import('./SkillVersionDetail')

const PATH = 'GET /agents/engineering/skills/fixer/versions/2?connection='
const AT = '2026-11-10T09:00:00Z'
const MARKUP = '<img src=x onerror="alert(1)"> Run the whole suite.'

const detail = (fields: Record<string, unknown> = {}) => ({ connection: '', role: 'fixer', version: {
  version: 2, status: 'proposed', summary: 'Fixer skill proposed: v1 → v2', why: { run_id: '', failure: '', comment: 'Stricter.' },
  proposed_by: 'admin-sub', proposed_by_kind: 'person', proposed_at: AT, accepted_by: '', accepted_at: '', rejected_by: '',
  rejected_at: '', restores: 0, base: { shared: true, version: 1 }, benchmark: { claimed: null, measured: null },
  expected_case: '', events: [], made_with: null,
  record: { instructions: `Plan the smallest fix.\n${MARKUP}`, examples: [], tool_policy: ['read_file'], model: 'model-a', harness: 'converse' },
  diff: { instructions: [['-', 'Plan a fix.'], ['+', MARKUP]], examples: [], tools_added: ['run'], tools_removed: [],
    tools_reordered: false, model: ['model-a', 'model-b'], harness: null, first: false },
  ...fields,
} })

function renderDetail(routes: Record<string, RouteHandler>, onBack = vi.fn<() => void>()) {
  routeFetchApi(routes, { missStatus: 500 })
  renderWithQueryClient(<SkillVersionDetail connection="" role="fixer" version={2} current={{ own: 1, shared: 0 }} onBack={onBack} />)
  return onBack
}

beforeEach(() => { resetFetchApi() })

describe('Agents → Skills: a version\'s detail', () => {
  it('shows its diff as lines removed and added, each said as such', async () => {
    renderDetail({ [PATH]: () => detail() })
    const removed = await screen.findByText('Plan a fix.')
    expect(removed.closest('li')).toHaveTextContent('Removed: Plan a fix.')
    expect(screen.getByText('run').closest('li')).toHaveTextContent('Added: run')
    expect(screen.getByText('Model: model-a → model-b')).toBeInTheDocument()
  })

  it('shows the record\'s text as text, never as HTML', async () => {
    renderDetail({ [PATH]: () => detail() })
    expect(await screen.findByText(MARKUP)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })

  it('names its base and how the coach made it', async () => {
    renderDetail({ [PATH]: () => detail({ made_with: { model: 'model-a', prompt: 'coach-prompt/2' }, expected_case: 'slug-cut-bug' }) })
    expect(await screen.findByText(/Written on shared version 1\./)).toBeInTheDocument()
    expect(screen.getByText(/expected to fix case slug-cut-bug/)).toBeInTheDocument()
    expect(screen.getByText(/made with model-a and prompt coach-prompt\/2/)).toBeInTheDocument()
  })

  it('says a version not in the scope is not there, and what to do', async () => {
    renderDetail({ [PATH]: () => { throw new ApiError(404, 'no such skill version') } })
    expect(await screen.findByText('Version 2 is not in this scope. Go back to the history and pick another.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says a failed read failed, and goes back to the history', async () => {
    const onBack = renderDetail({})
    expect(await screen.findByRole('alert')).toHaveTextContent('The version could not be loaded. Try again in a moment.')
    await userEvent.click(screen.getByRole('button', { name: 'Back to the history' }))
    expect(onBack).toHaveBeenCalledWith()
  })
})
