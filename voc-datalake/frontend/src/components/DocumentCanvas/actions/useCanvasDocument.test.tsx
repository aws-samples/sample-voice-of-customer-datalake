/**
 * The canvas's save in place: ONE PUT per Save with the revision it loaded and a fresh edit
 * id (the title only for a research / custom document), the saved version selected after;
 * a 409 is the conflict (Load the latest reloads the editor); Discard goes back to the
 * stored text; leaving a dirty canvas — a route change in a data router, closing the
 * window — asks first; ⌘/Ctrl+S saves; a viewer never writes.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryRouter, Link, MemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import { createTestQueryClient } from '../../../test/query-client'
import { ApiError } from '../../../lib/errors'
import enComponents from '../../../../public/locales/en/components.json'
import { ignoreRejection } from '../../../lib/rejections'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import { VIEWER_ACCESS } from '../../../pages/ProjectDetail/projectAccess-fixtures'
import { useGuardedAction } from '../../UnsavedChangesGuard/guardRegistry'
import CanvasEditor from '../editor/CanvasEditor'
import enProjectDetail from '../../../../public/locales/en/projectDetail.json'
import { FakeCanvasEditor } from './canvas-editor-fixtures'
import { ConflictBanner } from './ConflictBanner'
import { useCanvasDocument } from './useCanvasDocument'
import type { Editor } from '@tiptap/core'
import type { ComponentType } from 'react'
import type { Project } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'
import type { CanvasEditorProps } from '../editor/CanvasEditor'

const api = vi.hoisted(() => ({
  updateDocument: vi.fn<(projectId: string, documentId: string, body: Record<string, unknown>, editKind?: string) => Promise<unknown>>(),
  getProject: vi.fn<(projectId: string) => Promise<unknown>>(),
}))
vi.mock('../../../api/projectsApi', () => ({ projectsApi: api }))

const project = makeProject({ project_id: 'p1' })
const viewerProject = makeProject({ project_id: 'p1', access: VIEWER_ACCESS })
const custom: ProjectDocument = {
  document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: 'stored', revision: 4, created_at: '2026-10-01T00:00:00Z',
}
const prd: ProjectDocument = {
  document_id: 'prd-2', document_type: 'prd', base_title: 'Launch', version: 2, title: 'Launch (v2)', content: '# PRD',
  created_at: '2026-10-01T00:00:00Z',
}

function Harness({ document, onSelectDoc, canvasProject = project, Editor = FakeCanvasEditor }: Readonly<{
  document: ProjectDocument; onSelectDoc: (doc: ProjectDocument) => void; canvasProject?: Project
  Editor?: ComponentType<CanvasEditorProps>
}>) {
  const state = useCanvasDocument({ project: canvasProject, document, onSelectDoc })
  return (
    <div>
      {/* As the page does: the editable canvas is on the hook's version, the read-only one on the selected copy. */}
      <Editor markdown={state.editable ? state.content : document.content} editable={state.editable} ariaLabel="canvas"
        onChange={state.onChange} handleRef={state.handleRef} />
      <input aria-label="title" value={state.title} onChange={(event) => state.setTitle(event.target.value)} />
      <p data-testid="dirty">{String(state.dirty)}</p>
      <p data-testid="last-saved">{state.lastSaved === null ? 'none' : `${state.lastSaved.document.document_id}:${state.lastSaved.content}`}</p>
      <p data-testid="generation">{state.generation}</p>
      <p data-testid="editable">{`${String(state.editable)}/${String(state.titleEditable)}`}</p>
      <button type="button" onClick={() => { state.save().catch(ignoreRejection) }}>save</button>
      <button type="button" onClick={state.discard}>discard</button>
      <button type="button" onClick={() => state.markRevised(() => true)}>revised</button>
      <button type="button" onClick={() => state.markRevised(null)}>not revised</button>
      {state.conflict === null ? null : (
        <>
          <button type="button" onClick={() => { void state.conflict?.onLoadLatest() }}>load latest</button>
          <button type="button" onClick={() => { state.conflict?.onSaveAnyway().catch(ignoreRejection) }}>save mine anyway</button>
          {/* The page's own banner too (its buttons are named as on the page). */}
          <ConflictBanner conflict={state.conflict} />
        </>
      )}
      <button type="button" onClick={state.reloadLatest}>reload</button>
      <Link to="/elsewhere">leave</Link>
      {state.guardDialog}
    </div>
  )
}

/** Mounted in a data router (so the route guard is live), under a fresh query client. */
function mount(document: ProjectDocument, canvasProject = project) {
  const onSelectDoc = vi.fn<(doc: ProjectDocument) => void>()
  const router = createMemoryRouter([
    { path: '/doc', element: <Harness document={document} onSelectDoc={onSelectDoc} canvasProject={canvasProject} /> },
    { path: '/elsewhere', element: <p>elsewhere</p> },
  ], { initialEntries: ['/doc'] })
  render(<QueryClientProvider client={createTestQueryClient()}><RouterProvider router={router} /></QueryClientProvider>)
  return { onSelectDoc, router, user: userEvent.setup() }
}

const canvas = () => screen.getByRole('textbox', { name: 'canvas' })

/** The custom document dirty on its canvas, while the server already holds a newer version with `content`. */
async function dirtyWithNewer(content: string) {
  const latest = { ...custom, content, revision: 5 }
  api.getProject.mockResolvedValue({ project, personas: [], documents: [latest] })
  const mounted = mount(custom)
  await mounted.user.type(canvas(), '!')
  return { ...mounted, latest }
}

/** dirtyWithNewer, then Save: the PUT answers 409 (the conflict is on screen). */
async function saveIntoConflict(content: string) {
  api.updateDocument.mockRejectedValue(new ApiError(409, 'stale'))
  const mounted = await dirtyWithNewer(content)
  await mounted.user.click(screen.getByRole('button', { name: 'save' }))
  return mounted
}

/** A save into a 409 (the server holds "theirs"), then Load the latest: the canvas is on "theirs". */
async function loadLatestAfterConflict(onConflict?: () => void) {
  const mounted = await saveIntoConflict('theirs')
  onConflict?.()
  await mounted.user.click(await screen.findByRole('button', { name: 'load latest' }))
  await waitFor(() => expect(canvas()).toHaveValue('theirs'))
  return mounted
}

/** The first save's (project, document, body), with the fresh edit id reduced to its type. */
function firstSave(): unknown {
  const call = api.updateDocument.mock.calls[0]
  if (call === undefined) return undefined
  const [projectId, documentId, body] = call
  return [projectId, documentId, { ...body, edit_id: typeof body.edit_id }]
}

/** Every PUT answers the version it stored: `edited` with the content sent, one revision on. */
function putStores(edited: ProjectDocument) {
  api.updateDocument.mockImplementation((_projectId, _documentId, body) =>
    Promise.resolve({ document: { ...edited, content: body.content, revision: (edited.revision ?? 0) + 1 } }))
}

beforeEach(() => {
  api.updateDocument.mockReset()
  api.getProject.mockReset()
})

describe('useCanvasDocument', () => {
  it('saves a research / custom document with its title, the revision it loaded and a fresh edit id, then selects the saved version', async () => {
    const saved = { ...custom, content: 'stored!', revision: 5 }
    api.updateDocument.mockResolvedValue({ document: saved })
    const { user, onSelectDoc } = mount(custom)

    await user.type(canvas(), '!')
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
    await user.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => expect(onSelectDoc).toHaveBeenCalledWith(saved))
    expect(firstSave()).toStrictEqual(['p1', 'doc-1', { title: 'Notes', content: 'stored!', expected_revision: 4, edit_id: 'string' }])
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
  })

  /** The PRD typed on ("!") and saved; resolves once the save landed (lastSaved). */
  async function savePrdEdit() {
    putStores(prd)
    const mounted = mount(prd)
    expect(screen.getByTestId('last-saved')).toHaveTextContent('none')
    await mounted.user.type(canvas(), '!')
    await mounted.user.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(screen.getByTestId('last-saved')).toHaveTextContent('prd-2:# PRD!'))
    return mounted
  }

  it('says what its last save stored and sent (lastSaved: "Revise from comments" marks threads by it), none before one', async () => {
    expect((await savePrdEdit()).onSelectDoc).toHaveBeenCalledExactlyOnceWith({ ...prd, content: '# PRD!', revision: 1 })
  })

  const generation = () => screen.getByTestId('generation').textContent

  it('its generation stays on a save, and moves on Discard (the draft replaced without a save)', async () => {
    const { user } = await savePrdEdit()
    expect(generation(), 'a save keeps it').toBe('0')

    await user.type(canvas(), '?')
    await user.click(screen.getByRole('button', { name: 'discard' }))
    expect(generation(), 'Discard').toBe('1')
  })

  it('its generation moves on Load the latest after a 409', async () => {
    await loadLatestAfterConflict(() => expect(generation(), 'the 409 keeps it').toBe('0'))

    expect(generation()).toBe('1')
  })

  // markRevised is "Revise from comments" saying its accepted changes are (or are no longer) in the draft.
  describe('a save holding changes accepted from "Revise from comments" (markRevised)', () => {
    const editKinds = () => api.updateDocument.mock.calls.map((call) => call[3] ?? 'none')
    /** `document` typed on, marked revised, then saved. */
    async function saveRevised(document: ProjectDocument) {
      putStores(document)
      const { user } = mount(document)
      await user.type(canvas(), '!')
      await user.click(screen.getByRole('button', { name: 'revised' }))
      await user.click(screen.getByRole('button', { name: 'save' }))
    }

    it('is recorded as a revise: the PRD\'s PUT carries edit_kind "revise"', async () => {
      await saveRevised(prd)
      await waitFor(() => expect(editKinds()).toStrictEqual(['revise']))
    })

    it('a plain edit, or one after the accepted changes left the draft, sends no edit_kind', async () => {
      const { user } = await savePrdEdit()
      await user.click(screen.getByRole('button', { name: 'revised' }))
      await user.click(screen.getByRole('button', { name: 'not revised' }))
      await user.type(canvas(), '?')

      await user.click(screen.getByRole('button', { name: 'save' }))

      await waitFor(() => expect(editKinds()).toStrictEqual(['none', 'none']))
    })

    it('never on a research / custom document (only a PR/FAQ / PRD is revised from comments)', async () => {
      await saveRevised(custom)
      await waitFor(() => expect(editKinds()).toStrictEqual(['none']))
    })
  })

  it('never sends a PRD title (its series owns it), and the title is not editable', async () => {
    putStores(prd)
    const { user } = mount(prd)
    expect(screen.getByTestId('editable')).toHaveTextContent('true/false')

    await user.type(canvas(), '!')
    await user.click(screen.getByRole('button', { name: 'save' }))

    await waitFor(() => expect(firstSave()).toStrictEqual(['p1', 'prd-2', { content: '# PRD!', expected_revision: 2, edit_id: 'string' }]))
  })

  it('a clean canvas saves nothing', async () => {
    const { user } = mount(custom)
    await user.click(screen.getByRole('button', { name: 'save' }))
    expect(api.updateDocument).not.toHaveBeenCalled()
  })

  it('a 409 offers Load the latest, which reloads the editor on the newest version and selects it', async () => {
    const { onSelectDoc, latest } = await loadLatestAfterConflict()

    expect(onSelectDoc).toHaveBeenCalledWith(latest)
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
  })

  it('reloading on the newest version (an approved edit) asks first while dirty, then loads it on Discard', async () => {
    const { user, onSelectDoc, latest } = await dirtyWithNewer('approved')

    await user.click(screen.getByRole('button', { name: 'reload' }))
    const dialog = await screen.findByRole('dialog', { name: enComponents.unsavedChanges.title })
    expect(api.getProject).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: enComponents.unsavedChanges.discard }))

    await waitFor(() => expect(canvas()).toHaveValue('approved'))
    expect(onSelectDoc).toHaveBeenCalledWith(latest)
  })

  it('Discard puts the stored text back', async () => {
    const { user } = mount(custom)
    await user.type(canvas(), ' and more')
    await user.clear(screen.getByRole('textbox', { name: 'title' }))

    await user.click(screen.getByRole('button', { name: 'discard' }))

    expect(canvas()).toHaveValue('stored')
    expect(screen.getByRole('textbox', { name: 'title' })).toHaveValue('Notes')
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
  })

  it('asks before a route change while dirty, and stays on Cancel', async () => {
    const { user, router } = mount(custom)
    await user.type(canvas(), '!')

    await user.click(screen.getByRole('link', { name: 'leave' }))

    const dialog = await screen.findByRole('dialog', { name: enComponents.unsavedChanges.title })
    await user.click(within(dialog).getByRole('button', { name: enComponents.unsavedChanges.cancel }))
    expect(router.state.location.pathname).toBe('/doc')
    expect(canvas()).toHaveValue('stored!')
  })

  it('lets a clean canvas leave without asking', async () => {
    const { user, router } = mount(custom)
    await user.click(screen.getByRole('link', { name: 'leave' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere'))
  })

  it('asks the browser before closing the window while dirty', async () => {
    const { user } = mount(custom)
    await user.type(canvas(), '!')

    const event = new Event('beforeunload', { cancelable: true })
    act(() => { window.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(true)
  })

  /** "stored!" saved, its PUT answering without the saved version. */
  async function savedWithoutAnswer() {
    api.updateDocument.mockResolvedValue({ document: null })
    const mounted = mount(custom)
    await mounted.user.type(canvas(), '!')
    await mounted.user.click(screen.getByRole('button', { name: 'save' }))
    return mounted
  }

  /** Once the refetch failed: the draft is still on the canvas, unsaved, and nothing was selected. */
  async function expectDraftKeptAfterFailedRefetch(onSelectDoc: ReturnType<typeof mount>['onSelectDoc']) {
    await waitFor(() => expect(api.getProject).toHaveBeenCalledWith('p1'))
    await act(() => Promise.resolve())
    expect(canvas()).toHaveValue('stored!')
    expect([screen.getByTestId('dirty').textContent, onSelectDoc.mock.calls]).toStrictEqual(['true', []])
  }

  it('an answer without the saved version reads it back from the server: selected, the page clean', async () => {
    const saved = { ...custom, content: 'stored!', revision: 5 }
    api.getProject.mockResolvedValue({ project, personas: [], documents: [saved] })
    const { onSelectDoc } = await savedWithoutAnswer()

    await waitFor(() => expect(onSelectDoc).toHaveBeenCalledWith(saved))
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
  })

  it('an answer without the saved version, and no copy to read back: the draft stays unsaved', async () => {
    api.getProject.mockRejectedValue(new ApiError(503, 'down'))
    const { onSelectDoc } = await savedWithoutAnswer()

    await expectDraftKeptAfterFailedRefetch(onSelectDoc)
  })

  it('Load the latest whose refetch fails keeps the conflict and the draft', async () => {
    api.updateDocument.mockRejectedValue(new ApiError(409, 'stale'))
    const { user, onSelectDoc } = await dirtyWithNewer('theirs')
    api.getProject.mockRejectedValue(new ApiError(503, 'down'))
    await user.click(screen.getByRole('button', { name: 'save' }))

    await user.click(await screen.findByRole('button', { name: 'load latest' }))

    await expectDraftKeptAfterFailedRefetch(onSelectDoc)
    expect(screen.getByRole('button', { name: 'load latest' })).toBeInTheDocument()
  })

  /** The custom document dirty ("stored!"), its checked save refused as stale: the conflict is on screen. */
  async function refusedAsStale() {
    api.updateDocument.mockRejectedValueOnce(new ApiError(409, 'stale'))
    const mounted = await dirtyWithNewer('theirs')
    await mounted.user.click(screen.getByRole('button', { name: 'save' }))
    await screen.findByRole('button', { name: 'save mine anyway' })
    return mounted
  }

  it('Discard after a 409 takes the conflict away with the draft: no banner, the stored text, clean, nothing written', async () => {
    const { user } = await refusedAsStale()

    await user.click(screen.getByRole('button', { name: 'discard' }))

    expect(screen.queryByRole('button', { name: 'save mine anyway' })).not.toBeInTheDocument()
    expect(canvas()).toHaveValue('stored')
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
    expect(api.updateDocument).toHaveBeenCalledTimes(1)
  })

  it('Save mine anyway on a canvas back to its stored text sends no PUT (never the old text over the newer version)', async () => {
    const { user } = await refusedAsStale()
    await user.type(canvas(), '{Backspace}')
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')

    await user.click(screen.getByRole('button', { name: 'save mine anyway' }))

    await act(() => Promise.resolve())
    expect(api.updateDocument).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'save mine anyway' })).not.toBeInTheDocument()
  })

  describe('a load answered after the canvas moved on, or was typed on', () => {
    const theirs = { ...custom, content: 'theirs', revision: 5 }
    /** The stand-in editor's text. */
    const canvasValue = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'canvas' }).value

    /** The project GET answers (the newest copy: `theirs`) only when the spec says so. */
    function heldGet() {
      const get: { answer?: () => void } = {}
      api.getProject.mockImplementation(() => new Promise((resolve) => {
        get.answer = () => resolve({ project, personas: [], documents: [theirs] })
      }))
      return {
        answer: () => act(async () => {
          get.answer?.()
          await new Promise((resolve) => { setTimeout(resolve, 0) })
        }),
      }
    }

    /** The conflict on screen, then Load the latest clicked, its GET on its way. */
    async function loadingAfterConflict() {
      const mounted = await refusedAsStale()
      const get = heldGet()
      await mounted.user.click(screen.getByRole('button', { name: 'load latest' }))
      await waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(1))
      return { ...mounted, get }
    }

    /** A clean canvas reloading on the newest version (the assistant's edit was approved), its GET on its way. */
    async function reloadingClean() {
      const get = heldGet()
      const mounted = mount(custom)
      await mounted.user.click(screen.getByRole('button', { name: 'reload' }))
      await waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(1))
      return { ...mounted, get }
    }

    it('text typed while the approved edit\'s reload is on its way stays on the canvas, still unsaved', async () => {
      const { user, get, onSelectDoc } = await reloadingClean()

      await user.type(canvas(), ' mine')
      await get.answer()

      expect([canvasValue(), screen.getByTestId('dirty').textContent, onSelectDoc.mock.calls])
        .toStrictEqual(['stored mine', 'true', []])
    })

    it('a title typed while the approved edit\'s reload is on its way stays, still unsaved', async () => {
      const { user, get, onSelectDoc } = await reloadingClean()

      await user.type(screen.getByRole('textbox', { name: 'title' }), '!')
      await get.answer()

      expect(screen.getByRole('textbox', { name: 'title' })).toHaveValue('Notes!')
      expect([canvasValue(), screen.getByTestId('dirty').textContent, onSelectDoc.mock.calls])
        .toStrictEqual(['stored', 'true', []])
    })

    it('Discard while Load the latest is on its way: the canvas and the selection stay as Discard left them', async () => {
      const { user, get, onSelectDoc } = await loadingAfterConflict()

      await user.click(screen.getByRole('button', { name: 'discard' }))
      await get.answer()

      expect([canvasValue(), screen.getByTestId('dirty').textContent, onSelectDoc.mock.calls])
        .toStrictEqual(['stored', 'false', []])
    })

    it('Discard while Load the latest is on its way, then the same change typed again: the answer still changes nothing', async () => {
      const { user, get, onSelectDoc } = await loadingAfterConflict()

      await user.click(screen.getByRole('button', { name: 'discard' }))
      // The text is back to what the load started on, but on a canvas that moved on (a new generation).
      await user.type(canvas(), '!')
      await get.answer()

      expect([canvasValue(), screen.getByTestId('dirty').textContent, onSelectDoc.mock.calls])
        .toStrictEqual(['stored!', 'true', []])
    })

    it('holds Save mine anyway (and Load the latest) while Load the latest is on its way', async () => {
      const { get } = await loadingAfterConflict()
      const banner = within(screen.getByRole('alert'))

      expect(banner.getByRole('button', { name: enProjectDetail.documentModal.conflictSaveAnyway })).toBeDisabled()
      expect(banner.getByRole('button', { name: enProjectDetail.documentModal.conflictReload })).toBeDisabled()
      await get.answer()
      await waitFor(() => expect(canvas()).toHaveValue('theirs'))
    })

    it('a save that lands while Load the latest is on its way stays on the canvas: the load\'s older copy is not put back', async () => {
      const { user, get, onSelectDoc } = await loadingAfterConflict()
      const saved = { ...custom, content: 'stored!', revision: 6 }
      api.updateDocument.mockResolvedValueOnce({ document: saved })

      await user.click(screen.getByRole('button', { name: 'save mine anyway' }))
      await waitFor(() => expect(onSelectDoc).toHaveBeenCalledWith(saved))
      await get.answer()

      expect([canvasValue(), screen.getByTestId('dirty').textContent, onSelectDoc.mock.calls])
        .toStrictEqual(['stored!', 'false', [[saved]]])
    })
  })

  it('saves on Ctrl+S', async () => {
    putStores(custom)
    const { user } = mount(custom)
    await user.type(canvas(), '!')

    await user.keyboard('{Control>}s{/Control}')

    await waitFor(() => expect(api.updateDocument).toHaveBeenCalledTimes(1))
  })

  it('runs the shared Cancel-keeps-the-draft contract (useCanvasDocument)', async () => {
    const landed: { refetch?: () => void } = {}
    function RefetchingHost() {
      const [held, setHeld] = useState(custom)
      useEffect(() => { landed.refetch = () => setHeld({ ...custom }) })
      return <Harness document={held} onSelectDoc={vi.fn()} />
    }
    const router = createMemoryRouter([
      { path: '/doc', element: <RefetchingHost /> },
      { path: '/elsewhere', element: <p>elsewhere</p> },
    ], { initialEntries: ['/doc'] })
    await expectCancelKeepsDraftGuarded({
      mount: () => { render(<QueryClientProvider client={createTestQueryClient()}><RouterProvider router={router} /></QueryClientProvider>) },
      edit: async (user) => { await user.type(canvas(), ' draft') },
      expectDraft: () => expect(canvas()).toHaveValue('stored draft'),
      leave: async (user) => { await user.click(screen.getByRole('link', { name: 'leave' })) },
      expectStayed: () => expect(router.state.location.pathname).toBe('/doc'),
      expectLeft: () => waitFor(() => expect(router.state.location.pathname).toBe('/elsewhere')),
      whileDialogOpen: () => { landed.refetch?.(); return Promise.resolve() },
    })
  })

  it('never writes for a viewer', async () => {
    const { user } = mount(custom, viewerProject)
    expect(screen.getByTestId('editable')).toHaveTextContent('false/false')
    await user.click(screen.getByRole('button', { name: 'save' }))
    expect(api.updateDocument).not.toHaveBeenCalled()
  })
})

const theirs = { ...custom, content: 'theirs', revision: 5 }

/** The canvas under a page whose selected copy of the document `arrive` replaces, as a refetch does. */
function mountRefetching(Editor: ComponentType<CanvasEditorProps> = FakeCanvasEditor) {
  const page: { arrive?: (doc: ProjectDocument) => void } = {}
  function RefetchingPage() {
    const [held, setHeld] = useState(custom)
    useEffect(() => { page.arrive = (doc) => setHeld(doc) })
    return <Harness document={held} onSelectDoc={vi.fn()} Editor={Editor} />
  }
  render(<QueryClientProvider client={createTestQueryClient()}><MemoryRouter><RefetchingPage /></MemoryRouter></QueryClientProvider>)
  return { arrive: (doc: ProjectDocument) => { act(() => page.arrive?.(doc)) }, user: userEvent.setup() }
}

describe('useCanvasDocument: a newer version arriving from the page (a refetch)', () => {
  it('follows it while the canvas is clean', () => {
    const { arrive } = mountRefetching()
    arrive(theirs)
    expect(canvas()).toHaveValue('theirs')
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
  })

  it('never replaces a dirty canvas: the draft stays, and its save meets the newer version as a conflict', async () => {
    api.updateDocument.mockRejectedValue(new ApiError(409, 'stale'))
    const { arrive, user } = mountRefetching()
    await user.type(canvas(), '!')

    arrive(theirs)

    expect(canvas()).toHaveValue('stored!')
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
    await user.click(screen.getByRole('button', { name: 'save' }))
    expect(await screen.findByRole('button', { name: 'load latest' })).toBeInTheDocument()
    expect(firstSave()).toStrictEqual(['p1', 'doc-1', { title: 'Notes', content: 'stored!', expected_revision: 4, edit_id: 'string' }])
  })

  /** Dirty, then (after `whileDirty`) the newer version arrives, then Discard: the canvas follows it, clean. */
  async function discardOnceTheirsArrived(whileDirty: (user: ReturnType<typeof userEvent.setup>) => Promise<unknown> = () => Promise.resolve()) {
    const { arrive, user } = mountRefetching()
    await user.type(canvas(), '!')
    await whileDirty(user)
    arrive(theirs)

    await user.click(screen.getByRole('button', { name: 'discard' }))

    expect(canvas()).toHaveValue('theirs')
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
    return user
  }

  it('Discard after it follows the newer version: its text, clean, and the next save checked against it', async () => {
    putStores(theirs)
    const user = await discardOnceTheirsArrived()

    await user.type(canvas(), '?')
    await user.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(firstSave()).toStrictEqual(['p1', 'doc-1', { title: 'Notes', content: 'theirs?', expected_revision: 5, edit_id: 'string' }]))
  })

  it('Discard after a 409, once the newer version reached the page: its text, clean, no conflict banner', async () => {
    api.updateDocument.mockRejectedValueOnce(new ApiError(409, 'stale'))
    await discardOnceTheirsArrived(async (user) => {
      await user.click(screen.getByRole('button', { name: 'save' }))
      await screen.findByRole('button', { name: 'save mine anyway' })
    })

    expect(screen.queryByRole('button', { name: 'save mine anyway' })).not.toBeInTheDocument()
  })
})

describe('useCanvasDocument with the real canvas editor', () => {
  // ProseMirror measures the DOM (coordsAtPos, scrollIntoView); jsdom has no layout, so every box is empty.
  beforeAll(() => {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
    Range.prototype.getClientRects = () => globalThis.document.createElement('div').getClientRects()
    Element.prototype.scrollIntoView = vi.fn()
    globalThis.document.elementFromPoint = () => null
  })

  /** TipTap puts the editor on its DOM node; the specs type through it. */
  const isEditor = (value: unknown): value is Editor => typeof value === 'object' && value !== null && 'chain' in value

  /** The canvas on the real editor, its selection guarded as the project page's is. */
  function GuardedPage({ selected }: Readonly<{ selected: (doc: ProjectDocument) => void }>) {
    const guarded = useGuardedAction()
    return (
      <>
        <Harness document={custom} onSelectDoc={(doc) => guarded(() => selected(doc))} Editor={CanvasEditor} />
        <button type="button" onClick={() => guarded(() => selected(prd))}>open the PRD</button>
      </>
    )
  }

  /** The real editor of the canvas on screen. */
  async function canvasEditor(): Promise<Editor> {
    const root = await screen.findByRole('textbox', { name: 'canvas' })
    const editor: unknown = Reflect.get(root, 'editor')
    if (!isEditor(editor)) throw new Error('no editor on the DOM')
    return editor
  }

  async function mountReal() {
    const selected = vi.fn<(doc: ProjectDocument) => void>()
    const router = createMemoryRouter([{ path: '/doc', element: <GuardedPage selected={selected} /> }], { initialEntries: ['/doc'] })
    render(<QueryClientProvider client={createTestQueryClient()}><RouterProvider router={router} /></QueryClientProvider>)
    return { selected, editor: await canvasEditor() }
  }

  /** Type at the end of the text, as a user would, without waiting for the editor's pause before its onChange. */
  function typeAtEnd(editor: Editor, text: string) {
    act(() => { editor.chain().setTextSelection(editor.state.doc.content.size - 1).insertContent(text).run() })
  }
  const pressSave = () => { act(() => { fireEvent.keyDown(window, { key: 's', ctrlKey: true }) }) }

  /** The PUT answers only when the spec says so; `saved` is the version it stored (the body as sent). */
  function deferredPut() {
    const put: { answer?: () => void } = {}
    api.updateDocument.mockImplementation((_projectId, _documentId, body) => new Promise((resolve) => {
      put.answer = () => resolve({ document: { ...custom, content: body.content, revision: 5 } })
    }))
    return { answer: () => act(async () => { put.answer?.(); await Promise.resolve() }) }
  }
  const sentContent = (n = 0) => api.updateDocument.mock.calls[n]?.[2].content
  /** Wait until `n` PUTs went out. */
  const puts = (n: number) => waitFor(() => expect(api.updateDocument).toHaveBeenCalledTimes(n))

  /** A second PUT went out with all of the text (" one two") on the revision the first one stored. */
  async function expectKeptTextSavedOnTop() {
    await puts(2)
    const body = api.updateDocument.mock.calls[1]?.[2]
    expect([body?.expected_revision, sentContent(1)]).toStrictEqual([5, expect.stringMatching(/^stored one two\n?$/)])
  }

  /** Type, save at once, then type more while the PUT is on its way, and let it answer. */
  async function typeOnWhileSaving() {
    const put = deferredPut()
    const mounted = await mountReal()
    typeAtEnd(mounted.editor, ' one')
    pressSave()
    await puts(1)
    typeAtEnd(mounted.editor, ' two')
    await put.answer()
    // The saved version is selected without asking (the newer text is kept, not lost).
    await waitFor(() => expect(mounted.selected).toHaveBeenCalledWith(expect.objectContaining({ revision: 5 })))
    return mounted
  }

  it('sends the text on the canvas when Ctrl+S comes before the editor\'s pause', async () => {
    putStores(custom)
    const { editor } = await mountReal()

    typeAtEnd(editor, ' typed')
    pressSave()

    await puts(1)
    expect(sentContent()).toContain('stored typed')
  })

  it('keeps what was typed while the save was on its way: still on the canvas, the page still unsaved', async () => {
    await typeOnWhileSaving()

    expect(sentContent()).toMatch(/^stored one\n?$/)
    expect({
      text: canvas().textContent, dirty: screen.getByTestId('dirty').textContent, asked: screen.queryByRole('dialog'),
    }).toStrictEqual({ text: 'stored one two', dirty: 'true', asked: null })
  })

  it('saves the kept text on top of the version just saved', async () => {
    await typeOnWhileSaving()
    putStores({ ...custom, revision: 5 })

    pressSave()

    await expectKeptTextSavedOnTop()
  })

  it('sends one PUT for a double Ctrl+S', async () => {
    const put = deferredPut()
    const { editor } = await mountReal()
    typeAtEnd(editor, '!')

    pressSave()
    pressSave()
    await puts(1)
    await put.answer()

    expect(api.updateDocument).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'load latest' })).not.toBeInTheDocument()
    expect(screen.getByTestId('dirty')).toHaveTextContent('false')
  })

  it('the unsaved-changes dialog\'s Save during a save sends what was typed after it before leaving', async () => {
    const put = deferredPut()
    const { editor, selected } = await mountReal()
    typeAtEnd(editor, ' one')
    pressSave()
    await puts(1)
    typeAtEnd(editor, ' two')

    fireEvent.click(screen.getByRole('button', { name: 'open the PRD' }))
    const dialog = await screen.findByRole('dialog', { name: enComponents.unsavedChanges.title })
    fireEvent.click(within(dialog).getByRole('button', { name: enComponents.unsavedChanges.save }))
    await put.answer()

    await expectKeptTextSavedOnTop()
    expect(selected).not.toHaveBeenCalledWith(prd)
    await put.answer()
    await waitFor(() => expect(selected).toHaveBeenCalledWith(prd))
  })

  it('keeps what was typed inside the editor\'s pause when a newer version arrives: on the canvas, unsaved, saved on the revision it was typed on', async () => {
    api.updateDocument.mockRejectedValue(new ApiError(409, 'stale'))
    const { arrive } = mountRefetching(CanvasEditor)
    typeAtEnd(await canvasEditor(), ' mine')

    arrive(theirs)

    expect([canvas().textContent, screen.getByTestId('dirty').textContent]).toStrictEqual(['stored mine', 'true'])
    pressSave()
    await puts(1)
    expect([api.updateDocument.mock.calls[0]?.[2].expected_revision, sentContent()]).toStrictEqual([4, expect.stringMatching(/^stored mine\n?$/)])
  })

  it('follows a newer version while clean (a restore): its text on the canvas, the page clean', async () => {
    const { arrive } = mountRefetching(CanvasEditor)
    await canvasEditor()

    arrive(theirs)

    expect([canvas().textContent, screen.getByTestId('dirty').textContent]).toStrictEqual(['theirs', 'false'])
  })

  /**
   * " one" typed and saved, its PUT on its way: `land` answers it and reports the canvas (its text, dirty) and
   * whether the saved version was selected.
   */
  async function oneOnItsWay() {
    const put = deferredPut()
    const mounted = await mountReal()
    typeAtEnd(mounted.editor, ' one')
    pressSave()
    await puts(1)
    const land = async () => {
      await put.answer()
      await act(() => Promise.resolve())
      const savedSelected = mounted.selected.mock.calls.some(([doc]) => doc.revision === 5)
      return [canvas().textContent, screen.getByTestId('dirty').textContent, savedSelected]
    }
    return { ...mounted, land }
  }

  it('a Discard while a save is on its way: its answer lands in the history, not on the canvas (clean, nothing selected)', async () => {
    const { land } = await oneOnItsWay()

    fireEvent.click(screen.getByRole('button', { name: 'open the PRD' }))
    const dialog = await screen.findByRole('dialog', { name: enComponents.unsavedChanges.title })
    fireEvent.click(within(dialog).getByRole('button', { name: enComponents.unsavedChanges.discard }))

    // The discarded text never comes back as unsaved, and the page stays on what the user picked.
    expect(await land()).toStrictEqual(['stored', 'false', false])
  })

  it('a Discard while a save is on its way, then more typing: what was typed after the Discard stays, on the version it was typed on', async () => {
    const { editor, land } = await oneOnItsWay()

    fireEvent.click(screen.getByRole('button', { name: 'discard' }))
    typeAtEnd(editor, ' two')
    await waitFor(() => expect(screen.getByTestId('dirty')).toHaveTextContent('true'))

    expect(await land()).toStrictEqual(['stored two', 'true', false])
    api.updateDocument.mockRejectedValue(new ApiError(409, 'stale'))
    pressSave()
    await puts(2)
    // Checked against the version the canvas is on: it meets the one the earlier save stored as a conflict.
    expect([api.updateDocument.mock.calls[1]?.[2].expected_revision, sentContent(1)]).toStrictEqual([4, expect.stringMatching(/^stored two\n?$/)])
    expect(await screen.findByRole('button', { name: 'save mine anyway' })).toBeInTheDocument()
  })

  describe('a save answered after the canvas moved on (its generation is over)', () => {
    const v5: ProjectDocument = { ...prd, document_id: 'prd-5', version: 5, title: 'Launch (v5)', content: 'Five' }
    const v4: ProjectDocument = { ...prd, document_id: 'prd-4', version: 4, title: 'Launch (v4)', content: 'Four' }
    const restored: ProjectDocument = { ...custom, content: 'Restored', revision: 6 }

    /** A page that really selects: guarded, as the project page's; `restore` goes through the canvas's selectDoc. */
    function SelectingPage({ first, selected }: Readonly<{ first: ProjectDocument; selected: (doc: ProjectDocument) => void }>) {
      const guarded = useGuardedAction()
      const [shown, setShown] = useState(first)
      const select = (doc: ProjectDocument) => guarded(() => { selected(doc); setShown(doc) })
      const state = useCanvasDocument({ project, document: shown, onSelectDoc: select })
      return (
        <>
          <CanvasEditor markdown={state.content} editable={state.editable} ariaLabel="canvas"
            onChange={state.onChange} handleRef={state.handleRef} />
          <p data-testid="dirty">{String(state.dirty)}</p>
          <p data-testid="selected">{shown.document_id}</p>
          {state.conflict === null ? null : <p>conflict</p>}
          <button type="button" onClick={() => select(v4)}>open v4</button>
          <button type="button" onClick={() => state.selectDoc(restored)}>restore</button>
          {state.guardDialog}
        </>
      )
    }

    /** The PUT answers (its version: `answered` with the text sent, as v6) or refuses with a 409, when told. */
    function heldPut(answered: ProjectDocument) {
      const put: { resolve?: (value: unknown) => void; reject?: (error: unknown) => void } = {}
      api.updateDocument.mockImplementation((_projectId, _documentId, body) => new Promise((resolve, reject) => {
        put.resolve = () => resolve({ document: { ...answered, document_id: 'v6', version: 6, revision: 6, content: body.content } })
        put.reject = reject
      }))
      const settle = (send: () => void) => act(async () => { send(); await Promise.resolve() })
      return {
        answer: () => settle(() => put.resolve?.(undefined)),
        refuse: () => settle(() => put.reject?.(new ApiError(409, 'stale'))),
      }
    }

    /** `first` on the real canvas, " mine" typed and saved, its PUT on its way; then `button` asks, and Discard. */
    async function savingThenDiscardFor(first: ProjectDocument, button: string) {
      const put = heldPut(first)
      const selected = vi.fn<(doc: ProjectDocument) => void>()
      const router = createMemoryRouter([{ path: '/doc', element: <SelectingPage first={first} selected={selected} /> }], { initialEntries: ['/doc'] })
      render(<QueryClientProvider client={createTestQueryClient()}><RouterProvider router={router} /></QueryClientProvider>)
      typeAtEnd(await canvasEditor(), ' mine')
      pressSave()
      await puts(1)
      fireEvent.click(screen.getByRole('button', { name: button }))
      const dialog = await screen.findByRole('dialog', { name: enComponents.unsavedChanges.title })
      fireEvent.click(within(dialog).getByRole('button', { name: enComponents.unsavedChanges.discard }))
      return { put, selected }
    }

    /** The canvas on `doc`'s text, clean, `doc` still the selection (picked once), no conflict banner. */
    async function expectOn(doc: ProjectDocument, selected: ReturnType<typeof vi.fn>) {
      await act(() => Promise.resolve())
      expect({
        text: canvas().textContent, dirty: screen.getByTestId('dirty').textContent,
        shown: screen.getByTestId('selected').textContent, picked: selected.mock.calls, conflict: screen.queryByText('conflict'),
      }).toStrictEqual({ text: doc.content, dirty: 'false', shown: doc.document_id, picked: [[doc]], conflict: null })
    }

    it('another version of the series picked and the draft discarded, then the PUT stores v6: the canvas stays on the picked version', async () => {
      const { put, selected } = await savingThenDiscardFor(v5, 'open v4')
      await waitFor(() => expect(canvas().textContent).toBe('Four'))

      await put.answer()

      await expectOn(v4, selected)
    })

    it('the same, the PUT refused as stale: no conflict banner on the picked version', async () => {
      const { put, selected } = await savingThenDiscardFor(v5, 'open v4')
      await waitFor(() => expect(canvas().textContent).toBe('Four'))

      await put.refuse()

      await expectOn(v4, selected)
    })

    it('a restore while a save is on its way: the canvas stays on the restored version when the save is answered', async () => {
      const { put, selected } = await savingThenDiscardFor(custom, 'restore')
      await waitFor(() => expect(canvas().textContent).toBe('Restored'))

      await put.answer()

      await expectOn(restored, selected)
    })
  })

  it('a canvas dirty by its title only keeps its text when a newer version arrives, and its save meets it as a conflict', async () => {
    api.updateDocument.mockRejectedValue(new ApiError(409, 'stale'))
    const { arrive, user } = mountRefetching(CanvasEditor)
    await canvasEditor()
    await user.type(screen.getByRole('textbox', { name: 'title' }), '!')

    arrive(theirs)

    expect([canvas().textContent, screen.getByTestId('dirty').textContent]).toStrictEqual(['stored', 'true'])
    pressSave()
    expect(await screen.findByRole('button', { name: 'load latest' })).toBeInTheDocument()
    expect(firstSave()).toStrictEqual(['p1', 'doc-1', { title: 'Notes!', content: 'stored', expected_revision: 4, edit_id: 'string' }])
  })

  it('leaves a viewer\'s canvas on the display text when another version of the series is selected', async () => {
    const page: { select?: (doc: ProjectDocument) => void } = {}
    /** As the page does: a read-only canvas shows the display text (stored ids as names). */
    const display = (content: string) => content.replaceAll('proj_9', 'Launch plan')
    function ViewerPage() {
      const [shown, setShown] = useState(prd)
      useEffect(() => { page.select = (doc) => setShown(doc) })
      const state = useCanvasDocument({ project: viewerProject, document: shown, onSelectDoc: vi.fn() })
      return (
        <CanvasEditor markdown={state.editable ? shown.content : display(shown.content)} editable={state.editable}
          ariaLabel="canvas" handleRef={state.handleRef} />
      )
    }
    render(<QueryClientProvider client={createTestQueryClient()}><MemoryRouter><ViewerPage /></MemoryRouter></QueryClientProvider>)
    await screen.findByRole('textbox', { name: 'canvas' })

    act(() => page.select?.({ ...prd, document_id: 'prd-3', version: 3, content: 'Built on proj_9' }))

    await waitFor(() => expect(canvas()).toHaveTextContent('Built on Launch plan'))
    expect(canvas().textContent).not.toContain('proj_9')
  })

  describe('Save mine anyway', () => {
    /** The real canvas dirty, its checked save refused as stale: the conflict banner's choice is on screen. */
    async function inConflict() {
      api.updateDocument.mockRejectedValueOnce(new ApiError(409, 'stale'))
      const mounted = await mountReal()
      typeAtEnd(mounted.editor, ' mine')
      pressSave()
      await screen.findByRole('button', { name: 'save mine anyway' })
      return mounted
    }

    it('is one save: a second call while it is on its way sends no second version', async () => {
      await inConflict()
      const put = deferredPut()

      fireEvent.click(screen.getByRole('button', { name: 'save mine anyway' }))
      fireEvent.click(screen.getByRole('button', { name: 'save mine anyway' }))
      await puts(2)
      await put.answer()

      expect(api.updateDocument).toHaveBeenCalledTimes(2)
      expect(api.updateDocument.mock.calls[1]?.[2]).not.toHaveProperty('expected_revision')
      await waitFor(() => expect(screen.getByTestId('dirty')).toHaveTextContent('false'))
    })

    it('a Ctrl+S during it waits for it and sends nothing more (no checked PUT on the old revision)', async () => {
      await inConflict()
      const put = deferredPut()

      fireEvent.click(screen.getByRole('button', { name: 'save mine anyway' }))
      await puts(2)
      pressSave()
      await put.answer()

      await waitFor(() => expect(screen.getByTestId('dirty')).toHaveTextContent('false'))
      expect(api.updateDocument).toHaveBeenCalledTimes(2)
    })
  })
})
