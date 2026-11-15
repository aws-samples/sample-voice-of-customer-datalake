/**
 * @fileoverview "New" without the wizard: a blank document on its canvas, no modal.
 *
 * - The Documents section's New creates a custom document at once (`POST /projects/{id}/documents`, empty content)
 *   under the first free "Untitled document" name, selects it and opens its page on the title, selected, so the name
 *   is typed over and the text written after it (the title is renamed in place: useCanvasDocument `rename`).
 * - A PRD / PR/FAQ section's "Blank" opens the draft pane (BlankDocumentDraft) on "Untitled PRD": the name of a PRD /
 *   PR/FAQ is its series, fixed once filed (every version keeps it), so it is chosen first; Enter or "Start writing"
 *   files it as a hand-written document (`origin: human`, the server's blank template, `create_id` so a retried
 *   request is one document; the same route as the Human-driven wizard's "Start writing"), then its page opens with
 *   the caret in the text. Escape or Cancel files nothing.
 *
 * Both start only once the open document's unsaved changes are settled (`guarded`, the page's guard).
 *
 * @module pages/ProjectDetail/useBlankDocument
 */
import { useCallback, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { normalizeProjectDocument } from '../../api/projectDetailSchema'
import { projectsApi } from '../../api/projectsApi'
import { projectKey } from '../../api/projectQueryKeys'
import { firstFreeTitle } from './blankTitles'
import type { TFunction } from 'i18next'
import type { GatedDocType } from '../../api/aiModeApi'
import type { ProjectDocument } from '../../api/types'
import type { BlankDocumentType } from './blankTitles'

/** A PRD / PR/FAQ being named in the draft pane, before anything is filed. */
export interface PendingBlank {
  readonly type: GatedDocType
  /** The predefined name the pane starts with. */
  readonly title: string
}

/** A document just created blank: its page opens once with focus on its title (custom) or its text (PRD, PR/FAQ). */
export interface FreshDocument {
  readonly documentId: string
  readonly focus: 'title' | 'text'
}

export interface BlankDocumentControls {
  /** The Documents section's New: a blank custom document, created at once and opened on its title. */
  readonly startCustom: () => void
  readonly creatingCustom: boolean
  /** The last blank custom document could not be created. */
  readonly customFailed: boolean
  /** A PRD / PR/FAQ section's "Blank": the draft pane, named before anything is filed. */
  readonly startManaged: (type: GatedDocType) => void
  readonly pending: PendingBlank | null
  /** File the pending PRD / PR/FAQ under `title`; its page opens once it is there. */
  readonly createPending: (title: string) => void
  readonly cancelPending: () => void
  readonly creatingPending: boolean
  /** The pending PRD / PR/FAQ could not be filed (the pane keeps its name for another try). */
  readonly pendingFailed: boolean
  readonly fresh: FreshDocument | null
  /** The fresh document's page took its focus: a later visit opens as any other. */
  readonly consumeFresh: () => void
}

interface BlankDocumentDeps {
  /** The page's project (undefined while the route has none: nothing is created). */
  readonly projectId: string | undefined
  /** Its documents (undefined while they load). */
  readonly documents: readonly ProjectDocument[] | undefined
  /** Runs `action` once the open document's unsaved changes are settled (it asks first). */
  readonly guarded: (action: () => void) => void
  /** The selection itself (not guarded again: `guarded` already asked). */
  readonly setSelectedDoc: (doc: ProjectDocument | null) => void
}

/** The predefined name of a blank document of `type`: "Untitled document", or the first free numbered one. */
function untitledTitle(type: BlankDocumentType, documents: readonly ProjectDocument[], t: TFunction<'projectDetail'>): string {
  const base = {
    custom: t('documents.blank.untitled.custom'),
    prd: t('documents.blank.untitled.prd'),
    prfaq: t('documents.blank.untitled.prfaq'),
  }[type]
  return firstFreeTitle(type, base, (n) => t('documents.blank.numbered', { title: base, n }), documents)
}

/** A fresh idempotency key: letters and digits only (the server's `create_id` rule). */
const newCreateId = () => crypto.randomUUID().replaceAll('-', '')

export function useBlankDocument({
  projectId: project, documents: listed, guarded, setSelectedDoc,
}: BlankDocumentDeps): BlankDocumentControls {
  const projectId = project ?? ''
  const documents = listed ?? []
  const { t } = useTranslation('projectDetail')
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingBlank | null>(null)
  const [fresh, setFresh] = useState<FreshDocument | null>(null)
  // One key per name tried: a retry of the same name is the same document, another name is another one.
  const attempt = useRef<{ readonly title: string; readonly createId: string } | null>(null)
  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: projectKey(projectId) }), [projectId, queryClient])
  const open = useCallback((document: ProjectDocument, focus: FreshDocument['focus']) => {
    setFresh({ documentId: document.document_id, focus })
    setSelectedDoc(document)
  }, [setSelectedDoc])

  const custom = useMutation({
    mutationFn: (title: string) => projectsApi.createDocument(projectId, { title, content: '', document_type: 'custom' }),
    onSuccess: ({ document }) => {
      void refresh()
      if (document !== null) open(document, 'title')
    },
  })
  const managed = useMutation({
    mutationFn: ({ type, title, createId }: { type: GatedDocType; title: string; createId: string }) =>
      projectsApi.startHandWrittenDocument(projectId, { document_type: type, title, create_id: createId }),
    onSuccess: ({ document }) => {
      void refresh()
      setPending(null)
      attempt.current = null
      // Read like every other answer; one the page cannot show is still filed (the refetch lists it).
      const filed = normalizeProjectDocument(document)
      if (filed !== null) open(filed, 'text')
    },
  })

  const startCustom = () => guarded(() => {
    // A PRD / PR/FAQ being named meanwhile goes (nothing of it was filed): the new document takes the page.
    if (!managed.isPending) {
      attempt.current = null
      setPending(null)
    }
    custom.mutate(untitledTitle('custom', documents, t))
  })
  const startManaged = (type: GatedDocType) => guarded(() => {
    managed.reset()
    attempt.current = null
    // The pane stands in the page's place: nothing else is selected meanwhile.
    setSelectedDoc(null)
    setPending({ type, title: untitledTitle(type, documents, t) })
  })
  const createPending = (title: string) => {
    if (pending === null || managed.isPending) return
    const previous = attempt.current
    const createId = previous?.title === title ? previous.createId : newCreateId()
    attempt.current = { title, createId }
    managed.mutate({ type: pending.type, title, createId })
  }
  const cancelPending = () => {
    if (managed.isPending) return
    managed.reset()
    attempt.current = null
    setPending(null)
  }
  const consumeFresh = useCallback(() => setFresh(null), [])

  return {
    startCustom, creatingCustom: custom.isPending, customFailed: custom.isError,
    startManaged, pending, createPending, cancelPending, creatingPending: managed.isPending, pendingFailed: managed.isError,
    fresh, consumeFresh,
  }
}
