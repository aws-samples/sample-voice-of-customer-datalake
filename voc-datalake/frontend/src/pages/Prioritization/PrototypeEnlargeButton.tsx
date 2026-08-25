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
 * ## The dialog behaviour is `ModalShell`'s, deliberately
 *
 * Escape, the focus move in, the focus return to this trigger, `role="dialog"`
 * and `aria-modal` all come from the shared shell. The audit behind issue #283
 * found 21 of 23 overlays in this app missing dialog semantics precisely because
 * each one re-implemented them; a full-viewport overlay is not the place to start
 * that again.
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
  const { t } = useTranslation('prioritization')
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
          adjacent content, it is a modal that does not exist until asked for. */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        className="inline-flex items-center gap-1 text-blue-600 hover:underline"
      >
        <Maximize2 size={12} />
        {t('preview.enlarge')}
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
          <h3 id={headingId} className="font-medium text-gray-900 truncate">
            {t('preview.prototypeTitle')}
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
              would otherwise click back to. */}
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            className="inline-flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900 flex-shrink-0"
          >
            <X size={16} />
            {t('common:actions.close')}
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
