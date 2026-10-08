/**
 * @fileoverview A Prioritization row's prototype preview: its mode, header and enlargeable frame.
 * @module pages/Prioritization/RowPrototypePanel
 */

import clsx from 'clsx'
import { Wand2 } from 'lucide-react'
import { useId, useMemo } from 'react'
import { isNonEmptyString } from '../../api/lenientFields'
import PrototypeLinkActions, { PrototypeLinkLifetimeNote } from '../../components/PrototypeLinkActions'
import PrototypeRenderer, { HtmlPrototypeFrame } from '../../components/PrototypeRenderer'
import { parsePrototypeSpec, looksLikeHtmlDocument } from '../../components/prototypeSpec'
import PrototypeEnlargeButton from './PrototypeEnlargeButton'
import type { ProjectDocument } from '../../api/types'
import type { PrototypeSpec } from '../../components/prototypeSpec'
import type { TFunction } from 'i18next'
import type { ReactElement } from 'react'

/** Decide how to render a prototype document: as HTML, a JSON spec, or not at all. */
function resolvePrototypeMode(
  content: string,
  protoFormat: string | undefined,
): { kind: 'html' } | {
  kind: 'spec';
  spec: PrototypeSpec
} | { kind: 'none' } {
  if (content === '') return { kind: 'none' }
  const isHtml = protoFormat === 'html' || (protoFormat === undefined && looksLikeHtmlDocument(content))
  if (isHtml) return { kind: 'html' }
  const spec = parsePrototypeSpec(content)
  return spec ? {
    kind: 'spec',
    spec,
  } : { kind: 'none' }
}

/**
 * The measure a JSON-spec prototype is laid out on inside the enlarge overlay.
 *
 * `PrototypeRenderer`'s own default is `max-w-2xl` — a readable column, correct in
 * the row's half-width pane and correct in the Documents tab, and invisible in both
 * because the pane is the tighter constraint. In a viewport-wide dialog it is the
 * only constraint, and the result is a 672px column in a mostly-empty panel: the
 * reader asked for the screen and got a taller version of the same column.
 *
 * Wider, but still capped. A spec is prose, forms and lists, and a stats grid or a
 * list stretched to a 2560px display is harder to read than the column was, not
 * easier. `max-w-5xl` roughly doubles the measure on a laptop while keeping lines
 * scannable; `mx-auto` keeps it centred, as it is in the row.
 */
const ENLARGED_SPEC_MEASURE = 'max-w-5xl mx-auto'

/**
 * The prototype panel's heading, and the two things a reader can do about a pane
 * this size.
 *
 * Split out of `PrototypePanel` because that function's branch count is capped by
 * eslint's `complexity` rule at 12 and adding the enlarge control put it at 13. A
 * genuine seam rather than an appeasement: everything here is about the AFFORDANCES,
 * and everything left there is about resolving which artifact to render.
 *
 * "Open in new tab" appears only with a `prototype_url` to open — a legacy
 * prototype is inline HTML with no address, and the blob indirection the Documents
 * tab uses for those is not worth carrying onto a page that lists every project.
 * The deadline beneath it is stated rather than implied, because that URL is a
 * signed session credential (see components/PrototypeLinkActions); the page
 * schedules its own re-signing in `Prioritization.tsx`, without which the link
 * would 403 for anyone who parks a pitch on screen for an hour.
 *
 * "Enlarge" appears for EVERY prototype the panel renders, url or not: it
 * re-renders the pane the row is already showing and needs no address of its own,
 * so a legacy inline prototype and a JSON spec get it as much as a signed one does.
 * It sits beside the anchor because the two answer the same question — "I cannot see
 * this properly" — and a reader comparing them should not have to find them in
 * different places.
 *
 * What each KIND gains differs, and the panel says so rather than implying they are
 * equal: an HTML prototype is a page in a frame and simply gets the viewport, while
 * a JSON spec is a document laid out on a readable measure, so it gains the height,
 * the scroll and a wider column (`ENLARGED_SPEC_MEASURE`) but is still capped — a
 * stats grid stretched across a 2560px display reads worse, not better.
 *
 * @param enlarged the prototype as the overlay should render it: the row's own
 *   pane element in a box that fills the dialog.
 */
function PrototypePanelHeader({
  url, noteId, documentTitle, enlarged, t,
}: {
  readonly url?: string
  readonly noteId: string
  readonly documentTitle?: string
  readonly enlarged: ReactElement
  readonly t: TFunction<'prioritization'>
}): ReactElement {
  return (
    <>
      <div className="flex items-center justify-between mt-2 gap-3">
        <h4 className="font-medium text-text-strong flex items-center gap-1.5">
          <Wand2 size={14} className="text-aim" />
          {isNonEmptyString(documentTitle) ? documentTitle : t('preview.prototypeTitle', { defaultValue: 'Prototype' })}
        </h4>
        <span className="flex items-center gap-3 text-xs flex-shrink-0">
          {url ? <PrototypeLinkActions url={url} noteId={noteId} /> : null}
          <PrototypeEnlargeButton documentTitle={documentTitle}>{enlarged}</PrototypeEnlargeButton>
        </span>
      </div>
      {/* Under the link, not beside it: this column is half a row wide, and the
          note wraps rather than truncates — the clipped end would be the warning. */}
      {url ? <PrototypeLinkLifetimeNote url={url} noteId={noteId} className="mt-1 text-xs" /> : null}
    </>
  )
}

/**
 * Renders a project's latest prototype under the PR/FAQ preview. Chooses the
 * iframe (HTML format) or the native JSON-spec renderer, or renders nothing
 * when there's no usable prototype.
 *
 * The embedded frame is 384px tall inside half a row — enough to recognise the
 * prototype, not enough to walk a room through it — so the header above it offers
 * the artifact bigger, two ways: out of the app in a new tab, and filling the
 * viewport in place. See `PrototypePanelHeader` for which of those a given
 * prototype gets and why.
 */
export function PrototypePanel({
  prototype, t,
}: {
  readonly prototype?: ProjectDocument
  readonly t: TFunction<'prioritization'>
}): ReactElement | null {
  const content = prototype?.content ?? ''
  const protoFormat = prototype?.prototype_format
  const url = prototype?.prototype_url
  // Minted per panel: a page shows one of these per row, and a module constant
  // would give every row's anchors the same aria-describedby target.
  const lifetimeNoteId = useId()
  // A new (S3-only) prototype has no `content` to run `resolvePrototypeMode`'s
  // heuristics against — treat presence of `prototype_url` as HTML directly.
  const mode = useMemo(
    () => (url ? { kind: 'html' as const } : resolvePrototypeMode(content, protoFormat)),
    [url, content, protoFormat],
  )
  if (mode.kind === 'none') return null
  /**
   * The artifact as the ROW shows it, and — for an HTML prototype — the very element
   * the overlay shows too: one description rendered in two boxes, the row's 384px
   * pane and the enlarge overlay's full-viewport one.
   *
   * One description rather than two, because the sizing lives on the CONTAINER —
   * this frame is `w-full h-full` either way. A second `HtmlPrototypeFrame` call
   * written for the overlay would be free to drift from this one, and the thing it
   * would drift away from is `useLoadedUrl`: the handling that lets a re-signed URL
   * through without reloading the frame under a reviewer, and lets an already-dead
   * one be replaced. A React element is a description and not an instance, so using
   * this in both places mounts a frame per box — and the overlay's box does not
   * exist until somebody opens it, `ModalShell` rendering nothing while closed.
   *
   * The FRAME is the whole of what has to be shared, and only the html branch has
   * one. A JSON spec carries no signed URL, so nothing about it can lapse under a
   * reader and nothing is at risk in rendering it twice — which is why the overlay
   * renders its own on a wider measure (`ENLARGED_SPEC_MEASURE`) while this copy
   * keeps the readable column the row's narrow pane needs.
   *
   * Mounting per box is also the cost of the reuse, and worth naming so nobody reads
   * "the row's pane, bigger" too literally: each box performs its own load, so the
   * enlarged frame starts at the prototype's FIRST screen regardless of where the
   * row's pane had got to, and both frames are live and executing while the overlay
   * is open. Accepted, not overlooked — `HtmlPrototypeFrame` exposes no navigation
   * state to hand over, and a live iframe cannot be moved between parents without
   * reloading. Compare `useLoadedUrl`: the reset it exists to prevent is the same
   * one, minus the part that made it a defect, since this one happens because a
   * reader asked rather than on a timer they cannot see.
   *
   * THE SPEC BRANCH LOSES ITS PLACE FOR A DIFFERENT REASON, and the caveat above
   * does not reach it: there is no frame and no load here, but the overlay mounts a
   * SECOND `PrototypeRenderer`, and the active screen is that component's own
   * `useState`. So a reader three screens into the row's spec prototype also opens
   * at screen one. Same symptom, different mechanism, and the fix would be a
   * different shape too — lifting `activeId` out of `PrototypeRenderer` so both
   * copies share it, which is a change to a component the Documents tab also
   * renders. Left as it is, deliberately, on the same reasoning as the html branch:
   * the enlarge is an explicit act by the reader, not a reset sprung on them.
   */
  const pane = mode.kind === 'html' ? (
    <HtmlPrototypeFrame url={url} html={content} title={prototype?.title} className="w-full h-full border-0" />
  ) : (
    <PrototypeRenderer spec={mode.spec} />
  )
  return (
    <div>
      <PrototypePanelHeader
        url={url}
        noteId={lifetimeNoteId}
        documentTitle={prototype?.title}
        enlarged={(
          /* Full height inside the overlay's panel, and scrollable for the JSON
             spec, which is a document rather than a frame and can be taller than
             the screen. */
          <div className={clsx('h-full', mode.kind === 'html' ? 'overflow-hidden' : 'overflow-y-auto p-4')}>
            {mode.kind === 'html' ? pane : <PrototypeRenderer spec={mode.spec} measureClassName={ENLARGED_SPEC_MEASURE} />}
          </div>
        )}
        t={t}
      />
      {mode.kind === 'html' ? (
        <div className="bg-card rounded-lg border overflow-hidden mt-2 h-96">
          {pane}
        </div>
      ) : (
        <div className="bg-card rounded-lg border p-3 sm:p-4 max-h-96 overflow-y-auto mt-2">
          {pane}
        </div>
      )}
    </div>
  )
}
