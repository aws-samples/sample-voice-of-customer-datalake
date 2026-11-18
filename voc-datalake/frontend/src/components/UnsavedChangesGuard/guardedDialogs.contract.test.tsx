/**
 * @fileoverview The editor DIALOGS under the shared unsaved-changes guard, run
 * through the shared contract (3.00.00 R2): edit, try to close (Escape, or the
 * Cancel button where Escape is off; every exit routes through the guard), the host re-renders with a
 * fresh copy of its data while the guard is open (a list refetch), Cancel keeps
 * the edit and the editor open, and the next close asks again.
 *
 * Covers PersonaEditModal, ScraperEditor and the People editor sheet's name (UserNameSection, under a data router:
 * closing the sheet is a move to `/admin/people`, which the router's blocker holds). The feedback form builder, a
 * page since 7.55.00, runs the contract in its own spec (FormBuilderPage.unsavedGuard.test.tsx); a new project
 * document has no dialog since 7.38.00: it opens blank on its canvas, whose guard is the canvas's own.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter, useNavigate } from 'react-router-dom'
import { createTestQueryClient } from '@test/query-client'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import { makePersona } from '../../pages/ProjectDetail/project-detail-fixtures'
import { makeScraper, scrapersApiStubModule } from '../../pages/Scrapers/scrapers-fixtures'
import { cognitoUser } from '../UserAdmin/userAdmin-fixtures'
import type { ReactElement } from 'react'
import type { GuardedEditorScenario } from '@test/unsavedGuardContract'

vi.mock('../../api/scrapersApi', async (importOriginal) => scrapersApiStubModule(importOriginal))
vi.mock('../../api/client', () => ({
  api: { updateUser: () => Promise.resolve({ success: true }), getCategoriesConfig: () => Promise.resolve({ categories: [] }) },
  fetchApi: () => Promise.resolve({}),
}))

const { default: PersonaEditModal } = await import('../../pages/ProjectDetail/PersonaEditModal')
const { default: UserEditorSheet } = await import('../UserAdmin/UserEditorSheet')
const { default: ScraperEditor } = await import('../../pages/Scrapers/ScraperEditor')

const pressEscape: GuardedEditorScenario['leave'] = async (user) => { await user.keyboard('{Escape}') }

/**
 * The contract for a dialog: `host(revision)` renders it; a new `revision`
 * is the host re-rendering with fresh data while the guard is open.
 */
function dialogScenario({ host, field, typed, expected, onClose, leave = pressEscape }: Readonly<{
  host: (revision: number) => ReactElement
  /** How the editor is closed (default Escape). */
  leave?: GuardedEditorScenario['leave']
  /** The field the edit types into (its accessible name). */
  field: string
  typed: string
  expected: string
  onClose: ReturnType<typeof vi.fn>
}>): GuardedEditorScenario {
  const client = createTestQueryClient()
  const view: { rerender?: (ui: ReactElement) => void } = {}
  const wrap = (revision: number) => <QueryClientProvider client={client}>{host(revision)}</QueryClientProvider>
  return {
    mount: () => { view.rerender = render(wrap(0)).rerender },
    edit: async (user) => { await user.type(screen.getByLabelText(field), typed) },
    expectDraft: () => expect(screen.getByLabelText(field)).toHaveValue(expected),
    leave,
    expectStayed: () => expect(onClose).not.toHaveBeenCalled(),
    expectLeft: () => expect(onClose).toHaveBeenCalledTimes(1),
    whileDialogOpen: () => { view.rerender?.(wrap(1)); return Promise.resolve() },
  }
}

/** The People page's path-driven sheet: closing it moves to `/admin/people`; `refresh` hands it a fresh user (a refetch). */
function personSheetScenario(): GuardedEditorScenario {
  const handle: { refresh?: () => void } = {}
  function Sheet() {
    const navigate = useNavigate()
    const [user, setUser] = useState(() => cognitoUser({ username: 'u1', given_name: 'Grace' }))
    useEffect(() => { handle.refresh = () => setUser(cognitoUser({ username: 'u1', given_name: 'Grace' })) })
    return <UserEditorSheet user={user} onClose={() => { void navigate('/admin/people') }} onDeleted={vi.fn()} />
  }
  const router = createMemoryRouter([
    { path: '/admin/people', element: <p>People list</p> },
    { path: '/admin/people/:item', element: <Sheet /> },
  ], { initialEntries: ['/admin/people/u1'] })
  return {
    mount: () => { render(<QueryClientProvider client={createTestQueryClient()}><RouterProvider router={router} /></QueryClientProvider>) },
    edit: async (user) => { await user.type(screen.getByLabelText('First Name'), 'ful') },
    expectDraft: () => expect(screen.getByLabelText('First Name')).toHaveValue('Graceful'),
    leave: pressEscape,
    expectStayed: () => expect(router.state.location.pathname).toBe('/admin/people/u1'),
    expectLeft: async () => { expect(await screen.findByText('People list')).toBeInTheDocument() },
    whileDialogOpen: () => { handle.refresh?.(); return Promise.resolve() },
  }
}

/** A host that owns a controlled editor's value, as ProjectDetail does. */
function ControlledPersonaHost({ revision, onClose }: Readonly<{ revision: number; onClose: () => void }>) {
  const [persona, setPersona] = useState(() => makePersona({ name: 'Ada' }))
  return (
    <div data-revision={revision}>
      <PersonaEditModal persona={persona} onChange={setPersona} onSave={() => Promise.resolve()} onClose={onClose} isSaving={false} />
    </div>
  )
}

describe('editor dialogs — Cancel keeps the draft and stays guarded (R2 contract)', () => {
  it('PersonaEditModal', async () => {
    const onClose = vi.fn()
    await expectCancelKeepsDraftGuarded(dialogScenario({
      host: (revision) => <ControlledPersonaHost revision={revision} onClose={onClose} />,
      field: 'Name', typed: ' L.', expected: 'Ada L.', onClose,
    }))
  })

  it('UserNameSection, in a person\'s editor sheet (a route change)', async () => {
    await expectCancelKeepsDraftGuarded(personSheetScenario())
  })

  it('ScraperEditor', async () => {
    const onClose = vi.fn()
    await expectCancelKeepsDraftGuarded(dialogScenario({
      host: () => <ScraperEditor scraper={makeScraper({ name: 'Reviews' })} isAdmin onSave={vi.fn()} onClose={onClose} />,
      field: 'Scraper Name', typed: ' EU', expected: 'Reviews EU', onClose,
      // Not dismissable by Escape (a stray key would drop a whole config): its Cancel button.
      leave: async (user) => { await user.click(screen.getByRole('button', { name: 'Cancel' })) },
    }))
  })
})
