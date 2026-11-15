/**
 * @fileoverview The page's side of a prototype's walkthrough (docs/prototype-builder.md Part 1): starts it once,
 * by itself, on a version the viewer has not seen unless the series says "don't show again"; replays it on
 * **Show walkthrough**; previews the editor's unsaved steps; asks the frame to pick an element for a new step.
 * Every frame message is untrusted: it moves this hook's own state and, for "don't show again", the viewer's
 * series flag; nothing reaches the server.
 *
 * Everything the hook holds is the shown version's: its state and port are recorded with the version's
 * document id and count for nothing once another version is shown (the review is not remounted per version,
 * and a version written before 6.17.00 sends no ready to replace them).
 * @module components/PrototypePins/useWalkthroughHost
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { WalkthroughStep } from '../../api/prototypeWalkthroughSchema'
import { markDontShowAgain, markSeen, shouldAutostart } from './walkthroughFlags'
import type { WalkthroughFlagScope } from './walkthroughFlags'
import { postToWalkthrough } from './walkthroughMessages'
import type { WalkthroughMessage } from './walkthroughMessages'

/** An element the editor picked in the frame (a new `seq` per pick). */
export interface PickedElement {
  readonly seq: number
  readonly selector?: string
  readonly anchor: NonNullable<WalkthroughStep['anchor']>
}

export interface WalkthroughHost {
  /** The frame's runtime said it is there (a version written before 6.17.00 has none). */
  readonly runtime: boolean
  /** How many saved steps the version has (0: no Show walkthrough). */
  readonly steps: number
  readonly picking: boolean
  readonly picked: PickedElement | null
  readonly onMessage: (message: WalkthroughMessage, port: MessagePort | null) => void
  readonly show: () => void
  readonly preview: (steps: readonly WalkthroughStep[], step: number) => void
  readonly pick: () => void
}

/** What the hook holds about one version, with that version's document id. */
interface VersionState {
  readonly documentId: string
  readonly steps: number | null
  readonly picking: boolean
  readonly picked: PickedElement | null
}

const EMPTY = (documentId: string): VersionState => ({ documentId, steps: null, picking: false, picked: null })

export function useWalkthroughHost(scope: WalkthroughFlagScope): WalkthroughHost {
  const [held, setHeld] = useState<VersionState>(() => EMPTY(scope.documentId))
  // The port and the preview mark, with the version they belong to.
  const port = useRef<{ readonly documentId: string; readonly port: MessagePort | null }>({ documentId: '', port: null })
  // A preview of unsaved steps is the editor's, not the viewer's walkthrough: its "don't show again" sets nothing.
  const previewing = useRef('')
  const scopeRef = useRef(scope)
  // Before the new version's frame can answer: a layout effect runs before the browser loads the frame.
  useLayoutEffect(() => { scopeRef.current = scope })
  const current = held.documentId === scope.documentId ? held : EMPTY(scope.documentId)

  const update = useCallback((change: (state: VersionState) => Partial<VersionState>) => {
    const documentId = scopeRef.current.documentId
    setHeld((last) => {
      const base = last.documentId === documentId ? last : EMPTY(documentId)
      return { ...base, ...change(base) }
    })
  }, [])

  const onMessage = useCallback((message: WalkthroughMessage, from: MessagePort | null) => {
    const shown = scopeRef.current
    port.current = { documentId: shown.documentId, port: from }
    switch (message.event) {
      case 'ready':
        update(() => ({ steps: message.steps, picking: false }))
        previewing.current = ''
        if (message.steps > 0 && shouldAutostart(shown)) {
          markSeen(shown)
          postToWalkthrough(from, { action: 'start', step: 0 })
        }
        break
      case 'dont-show-again':
        if (previewing.current !== shown.documentId) markDontShowAgain(shown)
        previewing.current = ''
        break
      case 'done':
      case 'skipped':
        previewing.current = ''
        break
      case 'picked':
        update((last) => ({ picking: false, picked: { seq: (last.picked?.seq ?? 0) + 1, selector: message.selector, anchor: message.anchor } }))
        break
      case 'pick-cancelled':
        update(() => ({ picking: false }))
        break
      default:
        break
    }
  }, [update])

  /** The shown version's port; a port from another version is none. */
  const shownPort = useCallback(() => (port.current.documentId === scopeRef.current.documentId ? port.current.port : null), [])

  const show = useCallback(() => {
    previewing.current = ''
    postToWalkthrough(shownPort(), { action: 'start', step: 0 })
  }, [shownPort])
  const preview = useCallback((steps: readonly WalkthroughStep[], step: number) => {
    previewing.current = scopeRef.current.documentId
    postToWalkthrough(shownPort(), { action: 'start', step, steps })
  }, [shownPort])
  const pick = useCallback(() => {
    const target = shownPort()
    if (target === null) return
    update(() => ({ picking: true }))
    postToWalkthrough(target, { action: 'pick' })
  }, [shownPort, update])

  return {
    runtime: current.steps !== null, steps: current.steps ?? 0, picking: current.picking, picked: current.picked,
    onMessage, show, preview, pick,
  }
}
