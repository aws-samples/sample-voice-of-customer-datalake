/**
 * @fileoverview Agents → Skills → one version, on the shared document component (7.52.00): a proposal opens on its
 * changes (its instructions compared with its base's as the document reads, each block said as added or removed, and
 * what else moved), its instructions read through the safe-Markdown policy (never raw HTML), its properties from the
 * split front-matter, its base and how it was made, a version not in the scope, a failed read, and the way back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { SkillVersionDetail } = await import('./SkillVersionDetail')

const PATH = 'GET /agents/engineering/skills/fixer/versions/2?connection='
const BASE = 'GET /agents/engineering/skills/fixer/versions/1?connection='
const AT = '2026-11-10T09:00:00Z'
const MARKUP = '<img src=x onerror="alert(1)"> Run the whole suite.'

const record = (instructions: string) => ({ instructions, examples: [], tool_policy: ['read_file'], model: 'model-a', harness: 'converse' })
const detail = (fields: Record<string, unknown> = {}) => ({ connection: '', role: 'fixer', version: {
  version: 2, status: 'proposed', summary: 'Fixer skill proposed: v1 → v2', why: { run_id: '', failure: '', comment: 'Stricter.' },
  proposed_by: 'admin-sub', proposed_by_kind: 'person', proposed_at: AT, accepted_by: '', accepted_at: '', rejected_by: '',
  rejected_at: '', restores: 0, base: { shared: true, version: 1 }, benchmark: { claimed: null, measured: null },
  expected_case: '', events: [], made_with: null,
  record: record(`Plan the smallest fix.\n\n${MARKUP}`),
  diff: { instructions: [['-', 'Plan a fix.'], ['+', MARKUP]], examples: [], tools_added: ['run'], tools_removed: [],
    tools_reordered: false, model: ['model-a', 'model-b'], harness: null, first: false },
  ...fields,
} })
const base = () => detail({ version: 1, status: 'accepted', base: null, record: record('Plan a fix.') })

function renderDetail(routes: Record<string, RouteHandler>, onBack = vi.fn<() => void>()) {
  routeFetchApi({ [BASE]: base, ...routes }, { missStatus: 500 })
  renderWithQueryClient(
    <TestRouter>
      <SkillVersionDetail connection="" role="fixer" version={2} current={{ own: 1, shared: 0 }} onBack={onBack} onPropose={null} />
    </TestRouter>,
  )
  return onBack
}

beforeEach(() => { resetFetchApi() })

describe('Agents → Skills: a version\'s document', () => {
  it('opens a proposal on its changes: its instructions compared with its base\'s, each block said as such', async () => {
    renderDetail({ [PATH]: () => detail() })
    expect(await screen.findByText('Removed:', { exact: false, selector: '.sr-only' })).toBeInTheDocument()
    const removed = document.querySelector('[data-diff="del"]')
    expect(removed).toHaveTextContent('Removed: Plan a fix.')
    expect(screen.getByText('Compared with v1, the version it was written on.')).toBeInTheDocument()
  })

  it('lists what else changes: the tools added and the model moved, in words', async () => {
    renderDetail({ [PATH]: () => detail() })
    const changes = await screen.findByRole('region', { name: 'Examples, tools, model and harness' })
    expect(within(changes).getByText('run').closest('li')).toHaveTextContent('Added: run')
    expect(within(changes).getByText('Model: model-a → model-b')).toBeInTheDocument()
  })

  it('reads its instructions through the safe-Markdown policy: raw HTML is never rendered', async () => {
    renderDetail({ [PATH]: () => detail() })
    await userEvent.click(await screen.findByRole('button', { name: 'Read' }))
    expect(await screen.findByText(/Plan the smallest fix\./)).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('note')).toHaveTextContent('Changes to this are proposed, then accepted by an administrator.')
  })

  it('shows its model, harness and tools as Properties above the instructions (a split front-matter)', async () => {
    renderDetail({ [PATH]: () => detail({ status: 'accepted' }) })
    const properties = await screen.findByRole('region', { name: 'Properties' })
    expect(within(properties).getByText('model-a')).toBeInTheDocument()
    expect(within(properties).getByText('read_file')).toBeInTheDocument()
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
