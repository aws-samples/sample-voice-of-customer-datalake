/**
 * Create a trial (7.71.00): the dialog says the trial only pauses at its end, sends the trial with the workspace, then
 * applies the starter pack in the NEW workspace (each call names it in `X-Workspace-Id`): the invite list's members
 * with their suggested playbooks, the template forms Off and the sample categories; a refused step is said and the
 * others still run; then the way into the trial's import wizard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { z } from 'zod'
import { createTestQueryClient } from '../../../test/query-client'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import CreateTrialDialog from './CreateTrialDialog'
import { isInviteEmail } from './invites'
import { STARTER_CATEGORIES, STARTER_TEMPLATES } from './trialPack'

const TRIAL_WS = { id: 'ws_01JCTRIL0000000000000000T1', name: 'Example Trial', slug: 'example-trial', role: 'admin' }

function renderDialog(onOpenImport = vi.fn()) {
  render(<QueryClientProvider client={createTestQueryClient()}>
    <CreateTrialDialog onClose={vi.fn()} onOpenImport={onOpenImport} />
  </QueryClientProvider>)
  return onOpenImport
}

async function fillIn(email = 'ana@example.com') {
  await userEvent.type(screen.getByLabelText('Name'), 'Example Trial')
  await userEvent.type(screen.getByLabelText('Address (slug)'), 'example-trial')
  await userEvent.type(screen.getByLabelText('Email'), email)
  await userEvent.selectOptions(screen.getByLabelText('Suggested playbook'), 'qa')
}

/** Create a trial whose member add answers `member` (the pack's other calls succeed); its result's status. */
async function createWithPack(member: () => unknown): Promise<HTMLElement> {
  routeFetchApi({
    'POST /platform/workspaces': () => ({ workspace: TRIAL_WS }),
    'POST /me/workspaces/current/members': member,
    'POST /feedback-forms': () => ({ success: true }),
    'PUT /settings/categories': () => ({ success: true }),
  })
  renderDialog()
  await fillIn()
  await userEvent.click(screen.getByRole('button', { name: 'Create the trial' }))
  return screen.findByRole('status')
}

beforeEach(() => { resetFetchApi() })

describe('CreateTrialDialog', () => {
  it('says plainly that the trial pauses at its end and never deletes itself, and that Cognito emails new accounts', () => {
    renderDialog()
    expect(screen.getByText(/A trial never deletes itself/)).toBeInTheDocument()
    expect(screen.getByText(/Cognito emails them a temporary password/)).toBeInTheDocument()
    expect(screen.getByLabelText('Length')).toHaveValue('30')
  })

  it('creates the trial, then applies the starter pack in the new workspace, then offers its import wizard', async () => {
    routeFetchApi({
      'POST /platform/workspaces': () => ({ workspace: TRIAL_WS }),
      'POST /me/workspaces/current/members': () => ({ member: { sub: 'sub-ana' } }),
      'POST /feedback-forms': () => ({ success: true, form: {} }),
      'PUT /settings/categories': () => ({ success: true }),
    })
    const onOpenImport = renderDialog()
    await fillIn()
    await userEvent.selectOptions(screen.getByLabelText('Length'), '14')
    await userEvent.click(screen.getByRole('button', { name: 'Create the trial' }))
    const done = await screen.findByRole('status')
    expect(within(done).getAllByRole('listitem')).toHaveLength(1 + STARTER_TEMPLATES.length + 1)
    expect(sentFetchApiBody('/platform/workspaces', 'POST')).toStrictEqual({ name: 'Example Trial', slug: 'example-trial',
      trial: { days: 14, pack: { forms: STARTER_TEMPLATES.map((flow) => flow.id), categories: true, playbooks: true } } })
    expect(sentFetchApiBody('/me/workspaces/current/members', 'POST')).toStrictEqual({ email: 'ana@example.com', role: 'admin', playbook: 'qa' })
    await userEvent.click(within(done).getByRole('button', { name: /Open the import wizard/ }))
    expect(onOpenImport).toHaveBeenCalledWith({ id: TRIAL_WS.id, name: TRIAL_WS.name, slug: TRIAL_WS.slug })
  })

  it('sends every starter-pack call to the new workspace, the forms Off and the sample categories as they are', async () => {
    await createWithPack(() => ({ member: {} }))
    const packCalls = fetchApi.mock.calls.filter(([endpoint]) => endpoint !== '/platform/workspaces')
    expect(packCalls.map(([, , scope]) => scope)).toStrictEqual(packCalls.map(() => ({ workspaceId: TRIAL_WS.id })))
    expect(sentFetchApiBody('/settings/categories', 'PUT')).toStrictEqual({ categories: STARTER_CATEGORIES })
    const bodies = fetchApi.mock.calls.filter(([endpoint]) => endpoint === '/feedback-forms')
      .map(([, options]) => (typeof options?.body === 'string' ? z.object({ enabled: z.boolean() }).parse(JSON.parse(options.body)) : null))
    expect(bodies).toStrictEqual(STARTER_TEMPLATES.map(() => ({ enabled: false })))
  })

  it('says a refused step with the server\'s reason and still runs the others', async () => {
    const done = await createWithPack(() => { throw new ApiError(403, 'This email has no account yet') })
    expect(within(done).getByText(/Could not add ana@example.com/)).toBeInTheDocument()
    expect(within(done).getByText(/sample categories/)).toBeInTheDocument()
  })

  it('sends nothing while the name, the address or an email cannot be used', async () => {
    renderDialog()
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-address')
    await userEvent.click(screen.getByRole('button', { name: 'Create the trial' }))
    expect(screen.getByText('Check the name and the address.')).toBeInTheDocument()
    expect(screen.getByText('Enter a valid email address, or remove this row.')).toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('adds and removes people, and creates with nobody when every row is removed', async () => {
    routeFetchApi({ 'POST /platform/workspaces': () => ({ workspace: TRIAL_WS }) })
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: 'Add a person' }))
    expect(screen.getAllByLabelText('Email')).toHaveLength(2)
    for (const remove of screen.getAllByRole('button', { name: 'Remove this person' })) await userEvent.click(remove)
    await userEvent.type(screen.getByLabelText('Name'), 'Example Trial')
    await userEvent.type(screen.getByLabelText('Address (slug)'), 'example-trial')
    for (const box of screen.getAllByRole('checkbox')) await userEvent.click(box)
    await userEvent.click(screen.getByRole('button', { name: 'Create the trial' }))
    expect(await screen.findByText('Example Trial is ready.')).toBeInTheDocument()
    expect(fetchApi.mock.calls.map(([endpoint]) => endpoint)).toStrictEqual(['/platform/workspaces'])
  })
})

describe('isInviteEmail', () => {
  it.each([['ana@example.com', true], [' ana@example.com ', true], ['ana@example', false], ['a@b@example.com', false],
    ['@example.com', false], ['ana @example.com', false]])('%s → %s', (email, valid) => {
    expect(isInviteEmail(email)).toBe(valid)
  })
})
