/**
 * @fileoverview The editor DIALOGS under the shared unsaved-changes guard, run
 * through the shared contract (3.00.00 R2): edit, try to close (Escape, or the
 * Cancel button where Escape is off; every exit routes through the guard), the host re-renders with a
 * fresh copy of its data while the guard is open (a list refetch), Cancel keeps
 * the edit and the editor open, and the next close asks again.
 *
 * Covers PersonaEditModal, DocumentModal, EditUserModal and ScraperEditor
 * (FormEditor runs the contract in its own spec).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '@test/query-client'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import { makePersona } from '../../pages/ProjectDetail/project-detail-fixtures'
import { makeScraper, scrapersApiStubModule } from '../../pages/Scrapers/scrapers-fixtures'
import { cognitoUser } from '../UserAdmin/userAdmin-fixtures'
import type { ReactElement } from 'react'
import type { GuardedEditorScenario } from '@test/unsavedGuardContract'

vi.mock('../../api/scrapersApi', async (importOriginal) => scrapersApiStubModule(importOriginal))
vi.mock('../../api/client', () => ({ api: { updateUser: () => Promise.resolve({ success: true }) } }))

const { default: PersonaEditModal } = await import('../../pages/ProjectDetail/PersonaEditModal')
const { default: DocumentModal } = await import('../../pages/ProjectDetail/DocumentModal')
const { default: EditUserModal } = await import('../UserAdmin/EditUserModal')
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
    whileDialogOpen: async () => { view.rerender?.(wrap(1)) },
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

function ControlledDocumentHost({ revision, onClose }: Readonly<{ revision: number; onClose: () => void }>) {
  const [title, setTitle] = useState('Launch plan')
  const [content, setContent] = useState('Body')
  return (
    <div data-revision={revision}>
      <DocumentModal
        isEditing title={title} content={content} isSaving={false}
        onTitleChange={setTitle} onContentChange={setContent} onSave={() => Promise.resolve()} onClose={onClose}
      />
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

  it('DocumentModal', async () => {
    const onClose = vi.fn()
    await expectCancelKeepsDraftGuarded(dialogScenario({
      host: (revision) => <ControlledDocumentHost revision={revision} onClose={onClose} />,
      field: 'Title', typed: ' v2', expected: 'Launch plan v2', onClose,
    }))
  })

  it('EditUserModal', async () => {
    const onClose = vi.fn()
    // A users-list refetch hands the modal a new (equal) user object.
    await expectCancelKeepsDraftGuarded(dialogScenario({
      host: () => <EditUserModal isOpen user={cognitoUser({ username: 'u1', given_name: 'Grace' })} onClose={onClose} onSuccess={vi.fn()} />,
      field: 'First Name', typed: 'ful', expected: 'Graceful', onClose,
    }))
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
