/**
 * @fileoverview Saving a document draft through its adapter, with the no-clobber contract.
 *
 * A save carries the version the draft was made on (the adapter's revision check); a conflict (by default a 409)
 * means someone saved in between (another tab, a teammate, the assistant). Instead of the second save silently
 * landing on top, the surface shows the conflict and the user chooses: **Compare and merge** (their changes taken
 * into this draft where they still apply), **Load the latest** (this draft discarded, the newest version loaded), or
 * **Save mine anyway** (the save again, unchecked). Nothing is lost either way: the other save stays in the history.
 *
 * A save may carry a mark (Projects: the "Revise from comments" pass whose accepted changes the text keeps). When the
 * adapter's server will not record the save with it (`refusalOf`), nothing is saved and the draft stays: the surface
 * shows the server's reason and offers "Save as my own edit" (the same save, unmarked).
 *
 * Every answer is checked against the draft's generation: a draft that moved on meanwhile (Discard, Load the latest,
 * another version followed) is not the one the save was made on, so its answer changes nothing there.
 *
 * @module components/Document/draft/useSaveFlow
 */
import { useCallback, useState } from 'react'
import { apiErrorStatus, HTTP_CONFLICT } from '../../../api/apiErrorStatus'
import type { DocumentAdapter, DocumentDraft, StoredDocument } from '../types'

interface SaveFlowDeps<S extends StoredDocument> {
  readonly adapter: DocumentAdapter<S>
  /** The stored version the draft was made on, read at save time (a save right after another is made on its result). */
  readonly stored: () => S
  /** Read at save time, so a save always sends the newest text. */
  readonly edits: () => DocumentDraft
  /** The draft's generation, read when a save is sent and again when it is answered (see the module's doc). */
  readonly generation: () => number
  /** The mark the text a save sends carries (null: none). */
  readonly markOf: (content: string) => string | null
  /** The version just saved, and what the save sent. */
  readonly onSaved: (saved: S, sent: DocumentDraft) => void
  /**
   * "Load the latest" found the newest copy (undefined: gone meanwhile). Called only while the draft is still the one
   * the load started on: same generation, same stored version, and nothing typed while the load was on its way.
   */
  readonly onLoaded: (latest: S | undefined) => void
}

export interface SaveFlow<S extends StoredDocument> {
  /** Save with the revision check: rejects on failure (the unsaved-changes guard waits for it). */
  readonly save: () => Promise<void>
  /** "Save mine anyway": save without the check. */
  readonly saveAnyway: () => Promise<void>
  /** Someone saved this document after the draft loaded it. */
  readonly conflict: boolean
  /** Read the newest copy and hand it to `onLoaded`. */
  readonly loadLatest: () => Promise<void>
  /** A load is on its way: the conflict's ways out wait for it. */
  readonly loading: boolean
  /** A save is on its way. */
  readonly saving: boolean
  /** The draft the conflict was about is gone (Discard): the banner, and its unchecked save, go with it. */
  readonly clearConflict: () => void
  /** The server would not record the last save with its mark: nothing was saved. Its reason (null: none given). */
  readonly refused: { readonly message: string | null } | null
  /** "Save as my own edit": the refused save again, unmarked (the same revision check). */
  readonly saveUnmarked: () => Promise<void>
  /** Rename: one new version carrying only the title (the stored text stays), with the revision check. */
  readonly rename: (title: string) => Promise<void>
  /** The newest copy of the stored version, read from the adapter (for Compare and merge). */
  readonly latest: () => Promise<S | undefined>
}

/** How a save is sent: checked against the stored version, marked, or a rename (the title alone). */
interface SaveMode {
  readonly checked: boolean
  readonly marked: boolean
  readonly title?: string
}

/** A 409 is a conflict unless the adapter says otherwise. */
const isConflict = (error: unknown): boolean => apiErrorStatus(error) === HTTP_CONFLICT

export function useSaveFlow<S extends StoredDocument>({
  adapter, stored, edits, generation, markOf, onSaved, onLoaded,
}: SaveFlowDeps<S>): SaveFlow<S> {
  const [conflict, setConflict] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(0)
  // The refused save: its check is kept, so "Save as my own edit" sends it again the same way, unmarked.
  const [refused, setRefused] = useState<{ readonly message: string | null; readonly checked: boolean } | null>(null)
  const { load, save: send, rename: renameStored, conflictOf = isConflict, refusalOf } = adapter

  const latest = useCallback(() => load(stored()), [load, stored])

  /** Save the edits; an answer for a draft that moved on since resolves and changes nothing. */
  const update = useCallback(async (mode: SaveMode) => {
    const sentOn = generation()
    const current = () => generation() === sentOn
    const on = stored()
    const sent = mode.title === undefined ? edits() : { title: mode.title, content: on.content }
    const mark = mode.marked ? markOf(sent.content) : null
    const write = (): Promise<S | null> => {
      const written = mode.title === undefined ? send?.(sent, on, { checked: mode.checked, mark }) : renameStored?.(mode.title, on)
      return written ?? Promise.reject(new Error('This document is not written here'))
    }
    // A failed save of this draft: the conflict or the refused mark it shows (nothing once the draft moved on).
    const failed = (error: unknown) => {
      if (!current()) return
      if (mode.checked && conflictOf(error)) setConflict(true)
      const refusal = mark === null ? null : refusalOf?.(error) ?? null
      if (refusal !== null) setRefused({ message: refusal.message, checked: mode.checked })
    }
    try {
      // "Saving" lasts as long as the write itself (a read-back after it is not a save on its way).
      setPending((count) => count + 1)
      const result = await write().finally(() => { setPending((count) => count - 1) })
      if (!current()) return
      setConflict(false)
      setRefused(null)
      // Every save is a new version: the one just saved, read back when the answer did not carry it (none found:
      // the save rejects and the draft stays unsaved).
      const saved = result ?? await load(on)
      if (!current()) return
      if (saved === undefined) throw new Error('The saved version could not be read back')
      onSaved(saved, sent)
    } catch (error) {
      failed(error)
      if (current()) throw error
    }
  }, [conflictOf, edits, generation, load, markOf, onSaved, refusalOf, renameStored, send, stored])

  const save = useCallback(() => update({ checked: true, marked: true }), [update])
  const saveAnyway = useCallback(() => update({ checked: false, marked: true }), [update])
  const saveUnmarked = useCallback(() => update({ checked: refused?.checked ?? true, marked: false }), [refused, update])
  const rename = useCallback((title: string) => update({ checked: true, marked: false, title }), [update])

  // A failed read rejects: the conflict stays on screen, and the draft with it. An answer for a draft that moved on,
  // or that was typed on meanwhile, changes nothing: what is in the draft now is newer than what the load was asked over.
  const loadLatest = useCallback(async () => {
    const startedOn = generation()
    const startedFrom = stored()
    const startedWith = edits()
    setLoading(true)
    try {
      const found = await load(startedFrom)
      const now = edits()
      if (generation() !== startedOn || stored() !== startedFrom) return
      if (now.content !== startedWith.content || now.title !== startedWith.title) return
      setConflict(false)
      setRefused(null)
      onLoaded(found)
    } finally {
      setLoading(false)
    }
  }, [edits, generation, load, onLoaded, stored])

  const clearConflict = useCallback(() => { setConflict(false); setRefused(null) }, [])

  return {
    save, saveAnyway, loadLatest, loading, saving: pending > 0, conflict, clearConflict,
    refused: refused === null ? null : { message: refused.message }, saveUnmarked, rename, latest,
  }
}
