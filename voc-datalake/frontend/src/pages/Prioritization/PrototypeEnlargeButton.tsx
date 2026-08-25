/**
 * @fileoverview Enlarging the prototype a prioritization row is showing, to the
 * whole viewport and back again (issue #314).
 *
 * The row's embedded pane is 384px tall inside half a table row: enough to
 * recognise a prototype, not enough for the thing a pitch session exists to do,
 * which is look at the artifact together. "Open in new tab" already covers the
 * reader who wants it out of the app entirely; this covers the meeting, where
 * leaving the page loses the sliders, the team's numbers and the room vote that
 * are the reason everyone is on this page.
 *
 * ## It renders the row's own frame, at a different size
 *
 * The prototype is handed in as `children` and the caller passes the very element
 * it renders in the row — `HtmlPrototypeFrame` for an HTML prototype, the native
 * `PrototypeRenderer` for a legacy JSON spec. Nothing about the artifact is
 * re-implemented here, which matters more than it sounds: `HtmlPrototypeFrame`
 * carries the signed-URL handling that makes a lapsed link degrade into a readable
 * message instead of a broken pane (see components/PrototypeRenderer's
 * `useLoadedUrl`), and a second frame written for the overlay would be the copy
 * that loses it. This component owns the size and the dialog, and nothing else.
 *
 * `children` is a ReactNode rather than a render prop because the sizing
 * difference is the CONTAINER, not the frame: the row wraps its frame in an
 * `h-96` box and this wraps the same `w-full h-full` frame in a box that fills
 * the viewport. An element passed here is created but not mounted until the
 * dialog opens, because `ModalShell` renders nothing while closed — so a row
 * showing a prototype pays for one frame, not two, until somebody asks.
 *
 * What "the row's own frame, at a different size" does NOT mean is the same frame
 * instance: each box mounts its own iframe, so opening this overlay performs a
 * fresh load and the enlarged prototype starts at its FIRST screen no matter which
 * screen the row's pane was showing, and both frames are live and executing while
 * the overlay is open. Accepted rather than missed — `HtmlPrototypeFrame` exposes
 * no navigation state to hand over, and a live iframe cannot be reparented without
 * reloading. It is the same loss of place `useLoadedUrl` exists to prevent, minus
 * the part that made that one a defect: this one happens because somebody asked,
 * not on a timer they cannot see.
 *
 * ## The dialog behaviour is `ModalShell`'s, deliberately
 *
 * Escape, the focus move in, the focus return to this trigger, the Tab trap,
 * `role="dialog"` and `aria-modal` all come from the shared shell. The audit behind
 * issue #283 found 21 of 23 overlays in this app missing dialog semantics precisely
 * because each one re-implemented them; a full-viewport overlay is not the place to
 * start that again.
 *
 * A key pressed inside an iframe is raised in the FRAME's document and never
 * reaches the embedder, which made both Escape and the trap inert for this overlay
 * the moment a reviewer clicked into the prototype — i.e. for almost all of its
 * useful life. That is fixed in the shell (see `ModalShell`'s NESTED FRAMES note)
 * rather than here, because the next consumer to embed a frame would otherwise
 * inherit the same silence.
 *
 * @module pages/Prioritization/PrototypeEnlargeButton
 */
import { Maximize2, X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModalShell from '../../components/ModalShell'
import type { ReactElement, ReactNode } from 'react'

/**
 * The trigger, and the full-viewport dialog it opens.
 *
 * @param documentTitle the prototype document's own title, shown beside the
 *   heading so the dialog names the artifact on screen rather than only its kind.
 *   Optional: a prototype is not required to carry one, and the heading alone
 *   still gives the dialog a non-empty accessible name.
 * @param children the prototype, as the caller already renders it in the row.
 *   Sized by this component's container, so pass a frame that fills its box.
 */
export default function PrototypeEnlargeButton({
  documentTitle, children,
}: {
  readonly documentTitle?: string
  readonly children: ReactNode
}): ReactElement {
  // Both namespaces this component reads, declared rather than left implicit: the
  // dialog's dismiss control reuses `common:actions.close` instead of minting a
  // ninth spelling of "Close", and that reach only resolves because `common` is
  // loaded. Today every namespace is loaded at init (`i18n/options.ts`), so naming
  // it changes nothing at runtime; it is what keeps this component correct if that
  // ever becomes lazy, which no test would otherwise catch.
  //
  // EVERY key below is namespace-qualified, and must stay that way:
  // `scripts/i18n-check.mjs` attributes an unqualified key to the single-string
  // namespace it finds on this hook, and finds none in the array form — so an
  // unqualified key here is filed under `common` and reported both missing-in-source
  // and unused, i.e. as a deletion candidate.
  const { t } = useTranslation(['prioritization', 'common'])
  const [isOpen, setIsOpen] = useState(false)
  // Names the dialog after the heading it already shows, so the accessible name
  // cannot drift from the visible one. `useId` because the page renders one of
  // these per expanded row, and a module constant would point every dialog at the
  // first row's heading.
  const headingId = useId()
  return (
    <>
      {/* `aria-haspopup="dialog"` for the same reason `FormQrButton` carries it:
          without it the control announces as a plain button and a screen-reader
          user learns they are in a dialog only after focus has moved there.
          `aria-expanded` would be wrong — this is not a disclosure revealing
          adjacent content, it is a modal that does not exist until asked for.

          `hover:text-blue-700` and NOT the `hover:underline` of the anchor beside
          it, following `FormQrButton`: underline on hover is what this app's links
          do, and this control stays on the page. The two share the blue and sit
          together because they answer the same question — "I cannot see this
          properly" — but the hover is where a reader learns which of them is about
          to take them somewhere. Stated because the neighbouring anchor's classes
          are one line away and copying them looks like consistency. */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700"
      >
        <Maximize2 size={12} />
        {t('prioritization:preview.enlarge', { defaultValue: 'Enlarge' })}
      </button>
      <ModalShell
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        ariaLabelledBy={headingId}
        // No max-width cap and a full-height panel: the point of this overlay is
        // that the artifact gets the screen. `ModalShell`'s own container keeps a
        // `p-4` gutter, so the panel's rounded corners and the overlay behind them
        // stay visible — a viewer can still see they are in a dialog they can
        // dismiss, which a literally edge-to-edge panel hides.
        panelClassName="h-full flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2 flex-shrink-0">
          {/* `min-w-0 flex-1` is what makes the `truncate` fire at all: a flex item's
              default `min-width: auto` refuses to shrink below its content, so a long
              document title would push this row wider and overflow the panel instead
              of ellipsising. Same shape as the `min-h-0` below, on the other axis —
              and the `flex-1 min-w-0 … truncate` pattern CategoriesManager uses. */}
          <h3 id={headingId} className="font-medium text-gray-900 truncate min-w-0 flex-1">
            {t('prioritization:preview.prototypeTitle', { defaultValue: 'Prototype' })}
            {/* The artifact's own name, inside the heading rather than beside it, so
                it is part of the dialog's accessible name instead of a second label
                a screen reader reaches only by exploring. Omitted when the document
                carries no title — an empty span would leave a stray separator. */}
            {documentTitle ? (
              <span className="ml-2 font-normal text-sm text-gray-500">{documentTitle}</span>
            ) : null}
          </h3>
          {/* Visible, and the panel's first focusable so this is where the shell
              puts focus on open. The shell's own ways out — Escape and an overlay
              click — are both invisible, and this overlay covers the row a viewer
              would otherwise click back to.
              It is also the only exit that cannot be swallowed by the artifact: a
              cross-origin or sandboxed prototype raises its keys in a document this
              page is not allowed to read, so Escape genuinely does not reach the
              shell from inside one (the shell listens through same-origin frames —
              see its NESTED FRAMES note — which is all it can do). A prototype
              served from another origin must still be dismissable, and this is how. */}
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="inline-flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900 flex-shrink-0"
          >
            <X size={16} />
            {t('common:actions.close', { defaultValue: 'Close' })}
          </button>
        </div>
        {/* `min-h-0` beside `flex-1`: a flex child's default `min-height: auto`
            refuses to shrink below its content, and an iframe's content is not
            something this box can measure — without it the frame pushes the panel
            past the viewport and the header scrolls away. */}
        <div className="flex-1 min-h-0">
          {children}
        </div>
      </ModalShell>
    </>
  )
}
