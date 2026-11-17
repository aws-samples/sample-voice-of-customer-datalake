/**
 * @fileoverview The draft's baseline and the version the feature selects: a newer selected version is followed while
 * the draft is clean (state reset during render, not in an effect), and skipped while it holds changes (its save then
 * meets the newer version as a conflict, never a silent replace), then followed once the draft is clean again.
 *
 * @module components/Document/draft/followVersion
 */
import { useCallback, useState } from 'react'
import type { DocumentAdapter, StoredDocument } from '../types'

export interface Baseline<S extends StoredDocument> {
  /** Which stored version this is: a new one resets the draft. */
  readonly key: string
  readonly content: string
  readonly title: string
  /** The stored version itself: the next save's revision check is against it. */
  readonly stored: S
  /** The draft's generation: a save is answered only on the one it was sent from. */
  readonly generation: number
  /** Followed from the selection (not moved to by this draft): the editor is reloaded on it. */
  readonly reload?: boolean
  /** On a followed one: the baseline it replaced, kept if the editor still held a change made on it. */
  readonly left?: Baseline<S>
}

export function useFollowedVersion<S extends StoredDocument>(
  adapter: DocumentAdapter<S>, document: S, editable: boolean, titleEditable: boolean,
) {
  const { versionOf } = adapter
  const baselineOf = useCallback((stored: S, generation: number): Baseline<S> => ({
    key: versionOf(stored).token, content: stored.content, title: stored.title, stored, generation,
  }), [versionOf])
  /** `stored` is a later version than `selected`. */
  const isAhead = (stored: S, selected: S) => (versionOf(stored).number ?? 0) > (versionOf(selected).number ?? 0)
  const [baseline, setBaseline] = useState(() => baselineOf(document, 0))
  const [draft, setDraft] = useState(document.content)
  const [title, setTitle] = useState(document.title)
  const dirty = editable && (draft !== baseline.content || (titleEditable && title !== baseline.title))
  // Followed, the selected version starts a new generation of the draft.
  const incoming = baselineOf(document, baseline.generation + 1)
  const [seen, setSeen] = useState(incoming.key)
  // A selected version skipped while the draft was dirty: followed once it is clean again (the change typed away,
  // say), while it is still the selection.
  const [skipped, setSkipped] = useState<string | null>(null)
  const follow = () => {
    setBaseline({ ...incoming, reload: true, left: baselineOf(baseline.stored, incoming.generation) })
    setDraft(incoming.content)
    setTitle(incoming.title)
    setSkipped(null)
  }
  if (incoming.key !== seen) {
    setSeen(incoming.key)
    // Another version is selected (a restore, an approved edit, a refetch), not the one this draft moved to itself:
    // follow it while clean. While dirty the draft and its baseline stay. The reload checks the editor's own text
    // first, and goes back to `left` if a change was typed in its pause.
    if (incoming.key === baseline.key) setSkipped(null)
    else if (dirty) setSkipped(incoming.key)
    else follow()
  } else if (skipped !== null && !dirty && skipped === incoming.key && incoming.key !== baseline.key) {
    // Never back to an older version: right after a save the baseline is the version just stored, ahead of the
    // selection until the feature selects it.
    if (isAhead(baseline.stored, document)) setSkipped(null)
    else follow()
  }
  return { baseline, setBaseline, draft, setDraft, title, setTitle, dirty, selectedKey: incoming.key, baselineOf }
}
