/**
 * @fileoverview The app's one hover-and-focus hint (docs/kiro-design-system.md › Tooltips), in place of the
 * native `title`, which waits 1–2 s for the browser's own delay and never shows on keyboard focus.
 *
 * ```tsx
 * <Tooltip kind="label" content={t('delete')}>
 *   <button type="button" className="icon-btn" aria-label={t('delete')} onClick={remove}><Trash2 size={16} /></button>
 * </Tooltip>
 * ```
 *
 * It wraps exactly one element, the trigger, and adds its handlers, ref and (for a description)
 * `aria-describedby` to it.
 * - `kind="label"`: an icon button's name, which the trigger already carries as `aria-label`; the bubble
 *   repeats it and is `aria-hidden`, so a screen reader does not hear it twice.
 * - `kind="description"`: extra information (a date, who changed it, the shortcut); the trigger is
 *   `aria-describedby` the bubble, which stays in the page while it is hidden.
 * An empty `content` shows nothing, so a hint that applies only sometimes is `content={cond ? hint : undefined}`.
 *
 * A tooltip is never the only place important information lives: a consequence, a mode's meaning or why
 * something is disabled is visible text, or an InfoTip. Timing in tooltipTiming.ts, placement in
 * positionFloating.ts.
 *
 * @module components/Tooltip/Tooltip
 */
import { cloneElement, useCallback, useEffect, useId, useState } from 'react'
import { TooltipBubble } from './TooltipBubble'
import { triggerHandlers, useTooltip } from './useTooltip'
import type { FocusEventHandler, PointerEventHandler, ReactElement, ReactNode, Ref } from 'react'
import type { FloatingPlacement } from './positionFloating'

/** The props a Tooltip composes with the trigger's own. */
interface TriggerProps {
  readonly onPointerEnter?: PointerEventHandler<HTMLElement>
  readonly onPointerLeave?: PointerEventHandler<HTMLElement>
  readonly onPointerDown?: PointerEventHandler<HTMLElement>
  readonly onFocus?: FocusEventHandler<HTMLElement>
  readonly onBlur?: FocusEventHandler<HTMLElement>
  readonly 'aria-describedby'?: string
  readonly 'data-tooltip'?: string
  readonly ref?: Ref<HTMLElement>
}

interface TooltipProps {
  readonly content: ReactNode
  readonly kind: 'label' | 'description'
  readonly placement?: FloatingPlacement
  readonly children: ReactElement<TriggerProps>
}

function assignRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null): void {
  if (typeof ref === 'function') ref(node)
  else if (ref !== null && ref !== undefined) ref.current = node
}

/** Calls the trigger's own handler, then the tooltip's (only while it has content). */
function compose<E>(own: ((event: E) => void) | undefined, tooltip: (event: E) => void, active: boolean) {
  return (event: E) => {
    own?.(event)
    if (active) tooltip(event)
  }
}

const isEmpty = (content: ReactNode): boolean =>
  content === undefined || content === null || content === false || content === ''

export function Tooltip({ content, kind, placement = 'top', children }: TooltipProps) {
  const tipId = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const { open, timer } = useTooltip()
  const active = !isEmpty(content)
  const own = children.props
  const ownRef = own.ref
  const setTrigger = useCallback((node: HTMLElement | null) => {
    setAnchor(node)
    assignRef(ownRef, node)
  }, [ownRef])
  useEffect(() => {
    if (!active) timer.dismiss()
  }, [active, timer])
  const ours = triggerHandlers(timer)
  const describedBy = kind === 'description' && active
    ? [own['aria-describedby'], tipId].filter(Boolean).join(' ')
    : own['aria-describedby']
  // The same element tree with or without content, so a hint that comes and goes never remounts (and
  // never blurs) its trigger.
  const trigger = cloneElement(children, {
    onPointerEnter: compose(own.onPointerEnter, ours.onPointerEnter, active),
    onPointerLeave: compose(own.onPointerLeave, ours.onPointerLeave, active),
    onPointerDown: compose(own.onPointerDown, ours.onPointerDown, active),
    onFocus: compose(own.onFocus, ours.onFocus, active),
    onBlur: compose(own.onBlur, ours.onBlur, active),
    'aria-describedby': describedBy,
    // What a page audit reads to know the element has a hint (e2e/lib/deepAudit.ts).
    'data-tooltip': active ? kind : undefined,
    ref: setTrigger,
  })
  const mounted = active && (kind === 'description' || open)
  return (
    <>
      {trigger}
      {mounted ? (
        <TooltipBubble id={kind === 'description' ? tipId : undefined} open={open} content={content} anchor={anchor}
          placement={placement} decorative={kind === 'label'} timer={timer} />
      ) : null}
    </>
  )
}
