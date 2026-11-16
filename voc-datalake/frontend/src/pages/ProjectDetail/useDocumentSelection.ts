/**
 * @fileoverview The Documents tab's selected document, deep-linkable as `/projects/<id>/documents/<docId>`
 * (projectPaths.ts; an old `?doc=` link is replaced by that path first).
 *
 * Selecting a document writes its path, and a path from outside — a reload, a pasted link, the Decisions card's
 * "PR/FAQ ready" link, Back — selects that document once the project's documents are loaded. Another document is a
 * history entry of its own; a new version of the same one (a save, a restore, the latest loaded) replaces the entry
 * and shows that version (full screen stays as it was).
 *
 * A PRD / PR/FAQ series opens on its latest version: an address naming an older version's row (a link from before
 * that version was superseded, Back after a save) is replaced by the latest's, with that older version shown read-only
 * (`/v/<n>`), checked once per address so a version saved meanwhile never moves a canvas that is being edited.
 *
 * @module pages/ProjectDetail/useDocumentSelection
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { documentPageKey, listedHeadOf } from './documentEdit'
import { tabPlace } from './projectPaths'
import type { ProjectPlaceControls } from './useProjectPlace'
import type { ProjectDocument } from '../../api/types'

function resolveSelection(
  docParam: string | null, held: ProjectDocument | null, documents: readonly ProjectDocument[] | undefined,
): ProjectDocument | null {
  if (docParam === null) return null
  if (held?.document_id === docParam) return held
  return documents?.find((d) => d.document_id === docParam) ?? null
}

/** A document whose page has no older versions to show (a prototype's pane, a decision's record). */
const showsNoVersions = (document: ProjectDocument) => document.document_type === 'prototype' || document.document_type === 'decision'

/**
 * The address a selection reached by navigation is replaced by, or null: an older PRD / PR/FAQ version's row by its
 * series' latest with that version on screen, an older version asked of a document that shows none by the document.
 */
function canonicalSelection(selected: ProjectDocument, documents: readonly ProjectDocument[], version: number | null) {
  if (version !== null) return showsNoVersions(selected) ? { documentId: selected.document_id, version: null } : null
  const head = listedHeadOf(selected, documents)
  if (head === null || head.document_id === selected.document_id || selected.version === undefined) return null
  return { documentId: head.document_id, version: selected.version }
}

/**
 * The selected document, DERIVED from the address on every render rather than copied into state by an effect: the
 * held object wins only while it is the document the address names (an edit shows the version just saved before the
 * refetch lands); any other address — a reload, a pasted link — resolves against the documents.
 */
export function useDocumentSelection(documents: readonly ProjectDocument[] | undefined, { place, go }: ProjectPlaceControls) {
  const [held, setHeld] = useState<ProjectDocument | null>(null)
  const { key } = useLocation()
  const docParam = place.tab === 'documents' ? place.documentId : null
  const selectedDoc = resolveSelection(docParam, held, documents)

  // Read when a selection lands (a save's answer may land after the person moved on, to full screen say).
  const latest = useRef({ place, selectedDoc })
  useLayoutEffect(() => { latest.current = { place, selectedDoc } })
  const setSelectedDoc = useCallback((doc: ProjectDocument | null) => {
    setHeld(doc)
    const { place: now, selectedDoc: current } = latest.current
    if (doc === null) {
      go(tabPlace('documents'), { replace: true })
      return
    }
    // The page's own move to a new version (a save, a restore, the latest loaded) shows it: no older version.
    const samePage = current !== null && documentPageKey(current) === documentPageKey(doc)
    go({ tab: 'documents', documentId: doc.document_id, version: null, focus: now.focus }, { replace: samePage })
  }, [go])

  // A link to a document this project does not have: dropped once the documents are known, so the address bar and
  // the (empty) selection agree — the same rule an unknown tab follows.
  const dangling = docParam !== null && documents !== undefined && selectedDoc === null
  useEffect(() => {
    if (dangling) go(tabPlace('documents'), { replace: true })
  }, [dangling, go])

  // Each address reached is checked once, with the documents it found (see the module's doc).
  const checkedKey = useRef<string | null>(null)
  useEffect(() => {
    if (documents === undefined || checkedKey.current === key) return
    checkedKey.current = key
    const canonical = selectedDoc === null ? null : canonicalSelection(selectedDoc, documents, place.version)
    if (canonical !== null) go({ ...place, ...canonical }, { replace: true })
  }, [documents, go, key, place, selectedDoc])

  return { selectedDoc, setSelectedDoc }
}
