/**
 * The document page's action bar: the save status (version and time of the stored version, "Unsaved changes",
 * "Saving…"), Save / Discard for editors only, "Full screen" (the focus view's toggle) and the "File" menu: Save with
 * its state, Share for a PR/FAQ or PRD only, the exports of the saved version (the PDF optionally with the open
 * comments), History (restoring a version selects it, which reloads the canvas) and Delete; the conflict banner under
 * it. The menu is a WAI-ARIA menu button (arrow keys, Escape back to the button).
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRef, isValidElement } from 'react'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createTestQueryClient } from '../../../test/query-client'
import enProjectDetail from '../../../../public/locales/en/projectDetail.json'
import enComponents from '../../../../public/locales/en/components.json'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import { useActionBarRects } from '../../StickyActionBar/actionBarRegistry'
import { canvasState } from './canvas-state-fixtures'
import DocumentActionsBar from './DocumentActionsBar'
import type { ReactElement } from 'react'
import type { CommentThread } from '../../../api/documentReviewSchema'
import type { DocumentVersion } from '../../../api/projectDetailSchema'
import type { ProjectDocument } from '../../../api/types'
import type { FocusViewControls } from '../page/useFocusView'
import type { DocumentShareControls } from './DocumentMenu'
import type { CanvasDocument } from './useCanvasDocument'

const api = vi.hoisted(() => ({
  getDocumentVersions: vi.fn<(projectId: string, documentId: string) => Promise<DocumentVersion[]>>(),
  restoreDocumentVersion: vi.fn<(projectId: string, documentId: string, versionId: string, editId: string) => Promise<ProjectDocument | null>>(),
}))
vi.mock('../../../api/projectsApi', () => ({ projectsApi: api }))

const printed = vi.hoisted(() => ({ open: vi.fn<(options: { title: string; content: unknown }) => unknown>() }))
vi.mock('../../../utils/printUtils', () => ({ openPrintWindow: (options: { title: string; content: unknown }) => printed.open(options) }))
const files = vi.hoisted(() => ({ download: vi.fn<(content: string, name: string, type: string) => void>() }))
vi.mock('../../../utils/file', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../utils/file')>(),
  downloadFile: (content: string, name: string, type: string) => files.download(content, name, type),
}))

const actions = enProjectDetail.canvas.actions
const menuText = enProjectDetail.canvas.menu
const exportText = enComponents.documentExport
const project = makeProject({ project_id: 'p1' })
const prd: ProjectDocument = {
  document_id: 'prd-3', document_type: 'prd', base_title: 'Launch', version: 3, title: 'Launch (v3)', content: '# Launch',
  created_at: '2026-10-01T00:00:00Z', updated_at: new Date(Date.now() - 2 * 60_000).toISOString(),
}
const custom: ProjectDocument = {
  document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: 'text', revision: 4, created_at: '2026-10-01T00:00:00Z',
}

const share: DocumentShareControls = { share: null, createShare: vi.fn(), revokeShare: vi.fn() }

function thread(id: string, status: 'open' | 'resolved', exact: string | null): CommentThread {
  return {
    comment_id: id, document_id: 'prd-3', version: 3, text: `comment ${id}`, status, flagged: false, created_at: '',
    anchor: exact === null ? null : { exact, prefix: '', suffix: '', heading: '' },
    author: { kind: 'user', name: 'Ada' }, from_review_link: false, addressed: null,
    replies: [{ reply_id: `${id}-r`, author: { kind: 'persona', name: 'Ben' }, text: `reply ${id}`, flagged: false, at: '' }],
  }
}

function focusControls(active = false): FocusViewControls {
  return { active, toggle: vi.fn() }
}

interface BarCase {
  readonly document?: ProjectDocument
  readonly canEdit?: boolean
  readonly state?: CanvasDocument
  readonly shareControls?: DocumentShareControls | null
  readonly threads?: readonly CommentThread[] | null
  readonly focus?: FocusViewControls
  readonly isDeleting?: boolean
}

function renderBar({
  document = prd, canEdit = true, state = canvasState(), shareControls = share, threads = null, focus = focusControls(),
  isDeleting = false,
}: BarCase = {}) {
  const onDeleteDoc = vi.fn()
  const focusButtonRef = createRef<HTMLButtonElement>()
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DocumentActionsBar project={project} document={document} canEdit={canEdit} state={state} share={shareControls}
        threads={threads} onDeleteDoc={onDeleteDoc} isDeleting={isDeleting} focus={focus} focusButtonRef={focusButtonRef} />
    </QueryClientProvider>,
  )
  return { onDeleteDoc, state, focus, focusButtonRef, user: userEvent.setup() }
}

const status = () => screen.getByRole('status')
const fileButton = () => screen.getByRole('button', { name: menuText.trigger })
const item = (name: string | RegExp) => screen.getByRole('menuitem', { name })

async function openFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(fileButton())
  return screen.getByRole('menu')
}

/** The React element the PDF export printed (its last call). */
function printedContent(): ReactElement<{ comments: { threads: readonly CommentThread[] } | null }> {
  const content = printed.open.mock.calls.at(-1)?.[0].content
  if (!isValidElement<{ comments: { threads: readonly CommentThread[] } | null }>(content)) throw new Error('nothing printed')
  return content
}

beforeEach(() => {
  vi.clearAllMocks()
  printed.open.mockReturnValue({})
})

describe('DocumentActionsBar: status, Save and Discard', () => {
  it('says which version is saved and when, with Save and Discard disabled while clean', () => {
    renderBar()
    expect(status()).toHaveTextContent(/^Saved · v3 · 2 min\. ago$/)
    expect(screen.getByRole('button', { name: actions.save })).toBeDisabled()
    expect(screen.getByRole('button', { name: actions.discard })).toBeDisabled()
  })

  it('counts a research / custom document\'s edits as its version', () => {
    renderBar({ document: custom })
    expect(status()).toHaveTextContent(/Saved · v4/)
  })

  it('says "Unsaved changes" and saves or discards while dirty', async () => {
    const { user, state } = renderBar({ state: canvasState({ dirty: true }) })
    expect(status()).toHaveTextContent(actions.status.unsaved)

    await user.click(screen.getByRole('button', { name: actions.save }))
    await user.click(screen.getByRole('button', { name: actions.discard }))

    expect(state.save).toHaveBeenCalledTimes(1)
    expect(state.discard).toHaveBeenCalledTimes(1)
  })

  it('registers Save and Discard as a bottom action bar, so the assistant launcher lifts above them (phone)', async () => {
    const box = { top: 780, bottom: 844, left: 0, right: 390, width: 390, height: 64, x: 0, y: 780 }
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...box, toJSON: () => box })
    onTestFinished(() => measured.mockRestore())
    function LauncherProbe() {
      return <p data-testid="bars">{useActionBarRects().length}</p>
    }
    render(<LauncherProbe />)
    renderBar({ state: canvasState({ dirty: true }) })

    await waitFor(() => expect(screen.getByTestId('bars')).toHaveTextContent('1'))
    expect(screen.getByRole('button', { name: actions.save }).closest('[data-action-bar]')).not.toBeNull()
  })

  it('says "Saving…" while a save is in flight', () => {
    renderBar({ state: canvasState({ dirty: true, saving: true }) })
    expect(status()).toHaveTextContent(actions.status.saving)
    expect(screen.getByRole('button', { name: actions.status.saving })).toBeDisabled()
  })

  it('shows the conflict banner under the bar', () => {
    renderBar({ state: canvasState({ conflict: { onLoadLatest: vi.fn(), onSaveAnyway: vi.fn(), saving: false, loading: false } }) })
    expect(screen.getByRole('alert')).toHaveTextContent(enProjectDetail.documentModal.conflict)
  })

  it('holds both of the conflict\'s ways out while a save is on its way, and says so', () => {
    renderBar({ state: canvasState({ conflict: { onLoadLatest: vi.fn(), onSaveAnyway: vi.fn(), saving: true, loading: false } }) })
    const alert = within(screen.getByRole('alert'))
    expect(alert.getByRole('button', { name: enProjectDetail.documentModal.conflictReload })).toBeDisabled()
    expect(alert.getByRole('button', { name: enProjectDetail.canvas.actions.status.saving })).toBeDisabled()
    expect(alert.queryByRole('button', { name: enProjectDetail.documentModal.conflictSaveAnyway })).not.toBeInTheDocument()
  })
})

describe('DocumentActionsBar: Full screen', () => {
  it.each([[false], [true]])('is a toggle button (pressed: %s) with its shortcut, that toggles the focus view', async (active) => {
    const { user, focus, focusButtonRef } = renderBar({ focus: focusControls(active) })
    const button = screen.getByRole('button', { name: enProjectDetail.canvas.focus.button })
    expect({
      pressed: button.getAttribute('aria-pressed'), keys: button.getAttribute('aria-keyshortcuts'),
      ref: button.isSameNode(focusButtonRef.current),
    }).toStrictEqual({ pressed: String(active), keys: 'Control+Shift+F Meta+Shift+F', ref: true })
    await user.click(button)
    expect(focus.toggle).toHaveBeenCalledTimes(1)
  })
})

/** The accessible name of the element that has focus (a menu item's label). */
const focusedName = () => document.activeElement?.querySelector('.truncate')?.textContent ?? document.activeElement?.textContent

describe('DocumentActionsBar: the File menu', () => {
  it('opens on a click with focus on its first item, moves with the arrow keys and closes on Escape', async () => {
    const { user } = renderBar({ state: canvasState({ dirty: true }) })
    expect(fileButton()).toHaveAttribute('aria-haspopup', 'menu')
    await user.click(fileButton())
    expect(screen.getByRole('menu', { name: menuText.trigger })).toBeInTheDocument()
    const visited = [focusedName()]
    for (const key of ['{ArrowDown}', '{ArrowUp}{ArrowUp}', '{Home}']) {
      await user.keyboard(key)
      visited.push(focusedName())
    }
    expect(visited).toStrictEqual([actions.save, enComponents.reviewShare.open, enProjectDetail.documents.deleteDocument, actions.save])
    await user.keyboard('{Escape}')
    expect({ menu: screen.queryByRole('menu'), focus: document.activeElement }).toStrictEqual({ menu: null, focus: fileButton() })
  })

  it('opens from the keyboard on ArrowUp with focus on the last item', async () => {
    const { user } = renderBar()
    fileButton().focus()
    await user.keyboard('{ArrowUp}')
    expect(item(enProjectDetail.documents.deleteDocument)).toHaveFocus()
  })

  it('holds the menu items in order: Save, Share, the exports, History, Delete', async () => {
    const { user } = renderBar({ threads: [] })
    const menu = await openFile(user)
    const names = [...menu.querySelectorAll('[role^="menuitem"]')].map((el) => {
      const label = el.querySelector('.truncate')?.textContent ?? ''
      return el.getAttribute('role') === 'menuitemcheckbox' ? `[${label}]` : label
    })
    expect(names).toStrictEqual([
      actions.save, enComponents.reviewShare.open, exportText.copy, exportText.downloadMarkdown, exportText.downloadPDF,
      `[${menuText.includeComments}]`, exportText.downloadTXT, exportText.copyToKiro, actions.history,
      enProjectDetail.documents.deleteDocument,
    ])
  })

  it('shows Save\'s state and keeps it inert while there is nothing to save', async () => {
    const { user, state } = renderBar()
    await openFile(user)
    const save = item(actions.save)
    expect(save).toHaveAttribute('aria-disabled', 'true')
    expect(save).toHaveAccessibleDescription(menuText.saved)
    await user.click(save)
    expect(state.save).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it.each([
    ['dirty', { dirty: true }, actions.status.unsaved, 'false'],
    ['saving', { dirty: true, saving: true }, actions.status.saving, 'true'],
  ] as const)('says the save is %s', async (_case, overrides, description, disabled) => {
    const { user } = renderBar({ state: canvasState(overrides) })
    await openFile(user)
    expect(item(actions.save)).toHaveAccessibleDescription(description)
    expect(item(actions.save)).toHaveAttribute('aria-disabled', disabled)
  })

  it('saves from the menu while dirty, closing it with focus back on File', async () => {
    const { user, state } = renderBar({ state: canvasState({ dirty: true }) })
    await openFile(user)
    await user.click(item(actions.save))
    expect(state.save).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(fileButton()).toHaveFocus()
  })

  it('tells a writer with unsaved changes that Export uses the saved version', async () => {
    const { user } = renderBar({ state: canvasState({ dirty: true }) })
    await openFile(user)
    expect(screen.getByText(actions.exportSavedHint)).toBeInTheDocument()
    expect(item(exportText.downloadMarkdown)).toHaveAccessibleDescription(actions.exportSavedHint)
  })

  it('downloads the stored Markdown named after the title', async () => {
    const { user } = renderBar({ state: canvasState({ dirty: true }) })
    await openFile(user)
    await user.click(item(exportText.downloadMarkdown))
    expect(files.download).toHaveBeenCalledWith('# Launch', 'Launch__v3_.md', 'text/markdown')
  })

  /** The saved version printed: its text holds the quotes "the launch date" (across a bold) and "settled". */
  const printedPrd: ProjectDocument = { ...prd, content: '# Launch\n\nWe move the **launch** date: settled.' }

  it('prints the PDF without comments unless asked, then with the open threads only', async () => {
    const open = thread('c1', 'open', 'the launch date')
    const { user } = renderBar({ document: printedPrd, threads: [open, thread('c2', 'resolved', 'settled')] })
    await openFile(user)
    await user.click(item(exportText.downloadPDF))
    expect(printedContent().props.comments).toBeNull()

    await openFile(user)
    const include = screen.getByRole('menuitemcheckbox', { name: menuText.includeComments })
    const before = include.getAttribute('aria-checked')
    await user.click(include)
    expect({ before, after: include.getAttribute('aria-checked') }).toStrictEqual({ before: 'false', after: 'true' })
    expect(screen.getByRole('menu'), 'the option keeps the menu open').toBeInTheDocument()
    await user.click(item(exportText.downloadPDF))
    expect(printedContent().props.comments?.threads).toStrictEqual([open])
  })

  it('prints the open threads with their quotes, the comment and the replies', async () => {
    const { user } = renderBar({ document: printedPrd, threads: [thread('c1', 'open', 'the launch date'), thread('c3', 'open', null)] })
    await openFile(user)
    await user.click(screen.getByRole('menuitemcheckbox', { name: menuText.includeComments }))
    await user.click(item(exportText.downloadPDF))
    render(printedContent())
    const section = within(screen.getByRole('region', { name: menuText.commentsHeading }))
    const quotes = section.getAllByRole('blockquote')
    expect(quotes.map((quote) => quote.textContent)).toStrictEqual(['the launch date', menuText.wholeDocument])
    expect(section.getByText('comment c1').textContent).toBe('Ada: comment c1')
    expect(section.getByText('reply c1').textContent).toBe('Ben: reply c1')
  })

  it('prints only the open threads placed in the printed version\'s text, and those on the whole document', async () => {
    const placed = thread('c1', 'open', 'the launch date')
    const whole = thread('c3', 'open', null)
    const { user } = renderBar({ document: printedPrd, threads: [placed, thread('c4', 'open', 'a passage edited away'), whole] })
    await openFile(user)
    await user.click(screen.getByRole('menuitemcheckbox', { name: menuText.includeComments }))
    await user.click(item(exportText.downloadPDF))
    expect(printedContent().props.comments?.threads).toStrictEqual([placed, whole])
  })

  it('offers no "Include open comments" for a document without comments', async () => {
    const { user } = renderBar({ document: custom, shareControls: null })
    await openFile(user)
    expect(screen.queryByRole('menuitemcheckbox')).not.toBeInTheDocument()
    expect(item(exportText.downloadPDF)).toBeInTheDocument()
  })

  it('offers Share for a PR/FAQ or PRD only', async () => {
    const { user } = renderBar()
    await openFile(user)
    expect(item(enComponents.reviewShare.open)).toBeInTheDocument()
  })

  it('names Share after an active link', async () => {
    const { user } = renderBar({ shareControls: {
      ...share,
      share: { share_id: 's', path: '/review/s', audience: { mode: 'anyone', domains: [], emails: [] }, created_at: '', created_by_name: '', expires_at: '', active: true },
    } })
    await openFile(user)
    expect(item(enComponents.reviewShare.openActive)).toBeInTheDocument()
  })

  it('offers no Share without the comments\' controls (the page passes none for a research / custom document)', async () => {
    const { user } = renderBar({ document: custom, shareControls: null })
    await openFile(user)
    expect(screen.queryByRole('menuitem', { name: enComponents.reviewShare.open })).not.toBeInTheDocument()
  })

  it('opens the review-link dialog with the share controls', async () => {
    const { user } = renderBar()
    await openFile(user)
    await user.click(item(enComponents.reviewShare.open))
    expect(screen.getByRole('dialog', { name: enComponents.reviewShare.title })).toBeInTheDocument()
  })

  it('shows a viewer no control that writes: the exports and History only', async () => {
    const { user } = renderBar({ canEdit: false, state: canvasState({ editable: false }) })
    for (const name of [actions.save, actions.discard]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    await openFile(user)
    for (const name of [actions.save, enComponents.reviewShare.open, enProjectDetail.documents.deleteDocument]) {
      expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument()
    }
    expect(item(actions.history)).toBeInTheDocument()
    expect(item(exportText.downloadMarkdown)).toBeInTheDocument()
  })

  it('deletes through the page, closing the menu first', async () => {
    const { user, onDeleteDoc } = renderBar()
    await openFile(user)
    await user.click(item(enProjectDetail.documents.deleteDocument))
    expect(onDeleteDoc).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('holds Delete while a delete is on its way', async () => {
    const { user, onDeleteDoc } = renderBar({ isDeleting: true })
    await openFile(user)
    const remove = item(enProjectDetail.documents.deleteDocument)
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    await user.click(remove)
    expect(onDeleteDoc).not.toHaveBeenCalled()
  })

  it('History lists the versions; restoring one selects it (the canvas reloads) and closes', async () => {
    const restored = { ...prd, document_id: 'prd-4', version: 4, title: 'Launch (v4)' }
    api.getDocumentVersions.mockResolvedValue([
      { version_id: 'prd-3', document_id: 'prd-3', version: 3, title: 'Launch (v3)', content: '# Launch', created_at: '2026-10-03T00:00:00Z', current: true, edit_kind: null, restored_from_version: null },
      { version_id: 'prd-1', document_id: 'prd-1', version: 1, title: 'Launch (v1)', content: '# Old', created_at: '2026-10-01T00:00:00Z', current: false, edit_kind: null, restored_from_version: null },
    ])
    api.restoreDocumentVersion.mockResolvedValue(restored)
    const { user, state } = renderBar()

    await openFile(user)
    await user.click(item(actions.history))
    const dialog = screen.getByRole('dialog', { name: enProjectDetail.documents.versions.title })
    await user.click(await within(dialog).findByRole('button', { name: 'Restore v1' }))
    await user.click(within(screen.getByRole('dialog', { name: enProjectDetail.documents.versions.restoreTitle }))
      .getByRole('button', { name: enProjectDetail.documents.versions.restore }))

    await vi.waitFor(() => { expect(state.selectDoc).toHaveBeenCalledWith(restored) })
    expect(screen.queryByRole('dialog', { name: enProjectDetail.documents.versions.title })).not.toBeInTheDocument()
  })

  it('gives a decision (edited in its tab) no Save and no History, but Export and Delete', async () => {
    const { user } = renderBar({ document: { ...custom, document_type: 'decision' }, state: canvasState({ editable: false }) })
    expect(screen.queryByRole('button', { name: actions.save })).not.toBeInTheDocument()
    await openFile(user)
    expect([actions.save, actions.history].map((name) => screen.queryByRole('menuitem', { name }))).toStrictEqual([null, null])
    expect(item(enProjectDetail.documents.deleteDocument)).toBeInTheDocument()
    expect(item(exportText.downloadMarkdown)).toBeInTheDocument()
  })
})
