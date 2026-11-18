/**
 * @fileoverview One line (`truncate`) or a few (`line-clamp-*`) of text that may be cut, with the whole text
 * in a tooltip **only when it is actually cut**: a name that fits shows no bubble.
 *
 * ```tsx
 * <TruncatedText as="p" className="truncate font-medium" text={agent.name} />
 * ```
 *
 * The text is not focusable: the whole of it is in the page already (a screen reader reads past the cut,
 * so the bubble is `aria-hidden`), and it must also be on the item's detail view, the place a keyboard or
 * touch reader finds it.
 *
 * @module components/Tooltip/TruncatedText
 */
import { useState } from 'react'
import { TooltipBubble } from './TooltipBubble'
import { useTooltip } from './useTooltip'
import type { ReactNode } from 'react'

type TextTag = 'span' | 'p' | 'h2' | 'h3' | 'code' | 'dd' | 'li'

interface TruncatedTextProps {
  /** The whole text: what the element shows (unless `children` does) and what the tooltip says. */
  readonly text: string
  /** The element's id (a dialog title that `aria-labelledby` points at). */
  readonly id?: string
  readonly as?: TextTag
  /** Carries the cut: `truncate` or `line-clamp-*`. */
  readonly className?: string
  /** What the element shows when it is not `text` itself (the same text with markup). */
  readonly children?: ReactNode
}

/** The element's content overflows its box: the text is cut. */
function isCut(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight
}

export function TruncatedText({ text, id, as: Tag = 'span', className, children }: TruncatedTextProps) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const { open, timer } = useTooltip()
  return (
    <>
      <Tag ref={setElement} id={id} className={className} data-tooltip="truncated"
        onPointerEnter={(event) => {
          if (isCut(event.currentTarget)) timer.pointerEnter(event.pointerType)
        }}
        onPointerLeave={() => timer.pointerLeave()}>
        {children ?? text}
      </Tag>
      {open ? (
        <TooltipBubble open content={text} anchor={element} placement="top" decorative timer={timer} />
      ) : null}
    </>
  )
}
