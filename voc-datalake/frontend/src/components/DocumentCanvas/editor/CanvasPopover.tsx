/** A small non-modal dialog on the canvas (the link editor, the image dialog): focus moves in, Esc or a click outside closes. */
import { type ReactNode, useEffect, useId, useRef } from 'react'
import type { Anchor } from './floating'

interface CanvasPopoverProps {
  readonly title: string
  readonly anchor: Anchor
  readonly onClose: () => void
  readonly children: ReactNode
}

export default function CanvasPopover({ title, anchor, onClose, children }: CanvasPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })

  // Once, on open: a host re-render (a new onClose) must not pull the focus back to the first field mid-typing.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus()
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) closeRef.current()
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      className="canvas-popover"
      style={{ top: anchor.top, left: anchor.left }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <h2 id={titleId} className="canvas-popover__title">{title}</h2>
      {children}
    </div>
  )
}
