/**
 * @fileoverview Agents → Skills → Propose a version (gap M, D6-2): written on the version the scope runs (its
 * properties a read-only front-matter), checked before anything is sent, reviewed as a diff, then PROPOSED (never
 * applied: the server's 201 is a proposal, whose review opens); a 409 means another version is in use now: **Read it
 * again** keeps the draft and the review then compares it with the version in use, which the next send names.
 *
 * The canvas is the shared editor's own (its suites); here it is a plain field, so the flow is what is tested.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { defined } from '@test/defined'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../components/Document/edit/MarkdownEdit', () => ({
  default: ({ markdown, ariaLabel, onChange }: { markdown: string; ariaLabel: string; onChange?: (value: string) => void }) => (
    <textarea aria-label={ariaLabel} defaultValue={markdown} onChange={(event) => onChange?.(event.target.value)} />
  ),
}))

const { SkillProposeSheet } = await import('./SkillProposeSheet')

const ROLES = 'GET /agents/engineering/skills?connection='
const PROPOSE = '/agents/engineering/skills/fixer/versions?connection='
const record = (instructions: string) => ({ instructions, examples: [], tool_policy: ['read_file'], model: 'model-a', harness: 'converse' })
const version = (number: number, instructions: string) => ({ connection: '', role: 'fixer', version: {
  version: number, status: 'accepted', summary: `v${String(number)}`, proposed_by: 'alice', proposed_by_kind: 'person',
  proposed_at: '2026-11-10T09:00:00Z', base: null, record: record(instructions), diff: { first: true },
} })
const roles = (current: number) => ({ connection: '', roles: [{ role: 'fixer', current_version: current, versions: current, latest: null }] })
const PROPOSED = { connection: '', role: 'fixer', version: { version: 5, status: 'proposed', summary: 'Run the new test first',
  proposed_by: 'alice', proposed_by_kind: 'person', proposed_at: '2026-11-17T09:00:00Z' }, event: null, announcement: null }

function renderSheet(routes: Record<string, RouteHandler>) {
  routeFetchApi({ [ROLES]: () => roles(3), 'GET /agents/engineering/skills/fixer/versions/3?connection=': () => version(3, 'Plan the smallest fix.'),
    ...routes }, { missStatus: 500 })
  const onProposed = vi.fn<(version: number) => void>()
  const onClose = vi.fn<() => void>()
  renderWithQueryClient(<TestRouter><SkillProposeSheet connection="" role="fixer" onClose={onClose} onProposed={onProposed} /></TestRouter>)
  return { onProposed, onClose }
}

const SUMMARY = 'Summary: what it changes, on one line'

/** The sheet once the version in use is read (the form, not its loading lines). */
async function openSheet() {
  await screen.findByLabelText(SUMMARY)
  return screen.getByRole('dialog', { name: 'Propose a version of Fixer' })
}

/** The sheet, with a summary written and the instructions given `extra` at their end. */
async function writeDraft(extra = '\n\nRun the new test first.') {
  const sheet = await openSheet()
  await userEvent.type(within(sheet).getByLabelText(SUMMARY), 'Run the new test first')
  await userEvent.type(await within(sheet).findByLabelText('Instructions'), extra)
  return sheet
}

beforeEach(() => { resetFetchApi() })

describe('Propose a version: write, then review', () => {
  it('is written on the version in use, its properties a read-only front-matter', async () => {
    renderSheet({})
    const sheet = await openSheet()
    expect(within(sheet).getByText(/Written on v3, the version in use\./)).toBeInTheDocument()
    expect(within(within(sheet).getByRole('region', { name: 'Properties' })).getByText('model-a')).toBeInTheDocument()
  })

  it('says what to fix before anything is sent: a summary, and something changed', async () => {
    renderSheet({})
    const sheet = await openSheet()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Review your change' }))
    expect(within(sheet).getByRole('alert')).toHaveTextContent('Write a summary')
    expect(within(sheet).getByRole('alert')).toHaveTextContent('Your version changes nothing yet')
    expect(fetchApi).not.toHaveBeenCalledWith(PROPOSE, expect.anything())
  })

  it('refuses an "## Examples" heading typed into the instructions', async () => {
    renderSheet({})
    const sheet = await writeDraft('\n\n## Examples\n\nWhen this, do that.')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Review your change' }))
    expect(within(sheet).getByRole('alert')).toHaveTextContent('Take out the “## Examples” heading')
  })

  it('reviews the change as a diff over the version in use before it is sent', async () => {
    renderSheet({})
    const sheet = await writeDraft()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Review your change' }))
    expect(within(sheet).getByText(/What your version changes from v3\./)).toBeInTheDocument()
    expect(within(sheet).getByText('Run the new test first.').closest('[data-diff]')).toHaveAttribute('data-diff', 'add')
  })
})

describe('Propose a version: send', () => {
  it('proposes it on the version the screen showed, and opens the proposal (never applied by itself)', async () => {
    const { onProposed } = renderSheet({ [`POST ${PROPOSE}`]: () => PROPOSED })
    const sheet = await writeDraft()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Review your change' }))
    await userEvent.click(within(sheet).getByRole('button', { name: 'Propose this version' }))
    await waitFor(() => { expect(onProposed).toHaveBeenCalledWith(5) })
    expect(sentFetchApiBody(PROPOSE, 'POST')).toStrictEqual({ base_version: 3, summary: 'Run the new test first',
      instructions: 'Plan the smallest fix.\n\nRun the new test first.', examples: [] })
  })

  it('on a 409 (a stale base) reads it again, keeps the draft, and compares it with the version in use now', async () => {
    const head = { current: 3 }
    const attempts: unknown[] = []
    const answers = [
      () => { throw new ApiError(409, 'it changed since you opened it: the version the scope runs was v3 and is v4 now; read it again') },
      () => PROPOSED,
    ]
    renderSheet({
      [ROLES]: () => roles(head.current),
      'GET /agents/engineering/skills/fixer/versions/4?connection=': () => version(4, 'Plan the smallest fix, then test it.'),
      [`POST ${PROPOSE}`]: (body) => {
        attempts.push(body)
        return defined(answers.shift(), 'an answer')()
      },
    })
    const sheet = await writeDraft()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Review your change' }))
    await userEvent.click(within(sheet).getByRole('button', { name: 'Propose this version' }))
    head.current = 4
    await userEvent.click(await within(sheet).findByRole('button', { name: 'Read it again' }))
    expect(await within(sheet).findByText(/Written on v3; v4 is in use now\./)).toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Propose this version' }))
    await waitFor(() => { expect(attempts).toHaveLength(2) })
    expect(attempts[1]).toMatchObject({ base_version: 4, instructions: 'Plan the smallest fix.\n\nRun the new test first.' })
  })

  it('says another refusal in the server\'s words', async () => {
    renderSheet({ [`POST ${PROPOSE}`]: () => { throw new ApiError(400, 'the version changes nothing: edit its instructions or its examples') } })
    const sheet = await writeDraft()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Review your change' }))
    await userEvent.click(within(sheet).getByRole('button', { name: 'Propose this version' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('The proposal was refused: the version changes nothing')
  })

  it('asks before a draft is discarded', async () => {
    const { onClose } = renderSheet({})
    const sheet = await writeDraft()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledWith()
  })
})
