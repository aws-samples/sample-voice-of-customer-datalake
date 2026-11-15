/**
 * @fileoverview The canvas's save in place (useCanvasDocument) under a test page, for its specs: a stand-in editor
 * on the hook's version, the title field, the hook's state as text (dirty, last save, generation), buttons for its
 * calls (save, discard, markRevised, the conflict's two ways out) and its banners. Components only (fast-refresh
 * clean); the documents and `mount` are in canvas-document-fixtures.
 */
import { Link } from 'react-router-dom'
import { ignoreRejection } from '../../../lib/rejections'
import { FakeCanvasEditor } from './canvas-editor-fixtures'
import { ConflictBanner, ReviseRefusedBanner } from './ConflictBanner'
import { useCanvasDocument } from './useCanvasDocument'
import type { ComponentType } from 'react'
import type { Project } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'
import type { CanvasEditorProps } from '../editor/CanvasEditor'
import type { RevisedBy } from './useCanvasDocument'

/** What "revised" marks by default: the pass "job-7", whose changes any text keeps. */
const KEPT_BY_ANY_TEXT: RevisedBy = { jobId: 'job-7', keeps: () => true }

export function Harness({ document, onSelectDoc, canvasProject, Editor = FakeCanvasEditor, revisedBy = KEPT_BY_ANY_TEXT }: Readonly<{
  document: ProjectDocument; onSelectDoc: (doc: ProjectDocument) => void; canvasProject: Project
  Editor?: ComponentType<CanvasEditorProps>
  /** What the "revised" button marks (markRevised). */
  revisedBy?: RevisedBy
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
      <button type="button" onClick={() => state.markRevised(revisedBy)}>revised</button>
      <button type="button" onClick={() => state.markRevised(null)}>not revised</button>
      {state.reviseRefused === null ? null : <ReviseRefusedBanner refused={state.reviseRefused} />}
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
