/**
 * @fileoverview A button that opens a `ModalShell` dialog named by its own
 * heading — the trigger half every "show this in a dialog" control shares
 * (`FormQrButton`, `PrototypeEnlargeButton`).
 *
 * The parts that are easy to get subtly wrong live here once instead of in each
 * caller:
 *
 * - `aria-haspopup="dialog"` on the trigger. Without it the control announces as
 *   a plain button and a screen-reader user learns they are in a dialog only
 *   after focus has already moved there — the difference between choosing to
 *   open it and discovering they did. `aria-expanded` would be the wrong
 *   companion: it belongs to disclosures that reveal adjacent content, and the
 *   dialog is not adjacent, it is modal and unmounted until asked for.
 * - The dialog's accessible name is its visible heading (`ariaLabelledBy`), so
 *   the two cannot drift. The id comes from `useId` because a page can render
 *   many of these — a form card per form, a prioritization row per prototype —
 *   and a module constant would point every dialog at the first one's heading.
 *
 * The dialog body is a render function so it can place that heading id and a
 * visible close control wherever its layout needs them; `ModalShell` renders
 * nothing while closed, so the body costs nothing until the trigger is pressed.
 *
 * @module components/ModalShell/DialogTrigger
 */
import { useId, useState } from 'react'
import ModalShell from './ModalShell'
import type { ReactElement, ReactNode } from 'react'

/** What the dialog body needs from the trigger. */
export interface DialogBodyContext {
  /** The id the body's heading must carry — it names the dialog. */
  readonly headingId: string
  /** Closes the dialog, for the body's visible dismiss control. */
  readonly close: () => void
}

/**
 * @param triggerClassName the trigger button's classes.
 * @param trigger the trigger button's content (icon and label).
 * @param panelClassName forwarded to `ModalShell`'s panel.
 * @param children renders the dialog body.
 */
export default function DialogTrigger({
  triggerClassName, trigger, panelClassName, children,
}: {
  readonly triggerClassName: string
  readonly trigger: ReactNode
  readonly panelClassName: string
  readonly children: (context: DialogBodyContext) => ReactNode
}): ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const headingId = useId()
  const close = () => setIsOpen(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        className={triggerClassName}
      >
        {trigger}
      </button>
      <ModalShell
        isOpen={isOpen}
        onClose={close}
        ariaLabelledBy={headingId}
        panelClassName={panelClassName}
      >
        {children({ headingId, close })}
      </ModalShell>
    </>
  )
}
