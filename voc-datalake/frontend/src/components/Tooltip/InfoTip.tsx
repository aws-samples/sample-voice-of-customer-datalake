/**
 * @fileoverview The ⓘ glyph that explains the thing beside it (a port of KiroCrew's `InfoTip`,
 * `website/src/components/InfoTip.tsx`): for an explanation that would not fit as visible text.
 *
 * - mouse: resting on the glyph shows the tip (the Tooltip timing), which stays while the pointer is on the
 *   glyph or the bubble;
 * - keyboard: focus shows it at once; Escape or blur hides it;
 * - click or tap: pins it open, until another click or tap, a press outside, Escape or blur.
 *
 * The tip is the glyph's description (`aria-describedby`) whether it shows or not, so a screen reader
 * hears it on focus. Unlike KiroCrew's, it never falls back to a native `title`.
 *
 * @module components/Tooltip/InfoTip
 */
import { Info } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { noCleanup } from '../../hooks/noCleanup'
import { TooltipBubble } from './TooltipBubble'
import { triggerHandlers, useTooltip } from './useTooltip'
import type { FloatingPlacement } from './positionFloating'

interface InfoTipProps {
  /** The explanation (already translated). */
  readonly text: string
  /** The glyph's name (already translated); "More information" by default. */
  readonly label?: string
  readonly placement?: FloatingPlacement
}

export function InfoTip({ text, label, placement = 'top' }: InfoTipProps) {
  const { t } = useTranslation('common')
  const tipId = useId()
  const [glyph, setGlyph] = useState<HTMLButtonElement | null>(null)
  const { open, timer } = useTooltip()
  // A press anywhere but the glyph and the bubble closes a pinned (or shown) tip.
  useEffect(() => {
    if (!open) return noCleanup
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (glyph?.contains(target) === true || document.getElementById(tipId)?.contains(target) === true) return
      timer.dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, timer, tipId, glyph])
  return (
    <>
      <button ref={setGlyph} type="button" className="icon-btn p-0.5 cursor-help" aria-label={label ?? t('infoTip.label')}
        aria-describedby={tipId} {...triggerHandlers(timer)} onClick={() => timer.togglePin()}>
        <Info size={14} aria-hidden="true" />
      </button>
      <TooltipBubble id={tipId} open={open} content={text} anchor={glyph} placement={placement} decorative={false}
        timer={timer} />
    </>
  )
}
