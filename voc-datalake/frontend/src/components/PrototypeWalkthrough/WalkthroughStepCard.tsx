/**
 * @fileoverview One step in the walkthrough editor: its number, title (≤ 80) and body (≤ 280), where it points, and
 * Move up / Move down (also Alt+Shift+Up / Down on the card, or drag the card), Preview from here and Remove.
 * @module components/PrototypeWalkthrough/WalkthroughStepCard
 */
import { useId } from 'react'
import type { DragEvent, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Crosshair, GripVertical, Play, Trash2 } from 'lucide-react'
import { WALKTHROUGH_LIMITS } from '../../api/prototypeWalkthroughSchema'
import type { WalkthroughStep } from '../../api/prototypeWalkthroughSchema'
import type { EditorStep } from './walkthroughSteps'

interface WalkthroughStepCardProps {
  readonly step: EditorStep
  readonly index: number
  readonly total: number
  readonly onChange: (step: WalkthroughStep) => void
  readonly onMove: (to: number) => void
  readonly onRemove: () => void
  readonly onPreview: () => void
  readonly onDragStart: () => void
  readonly onDrop: () => void
  /** Re-point the step by picking an element in the preview (absent: the preview cannot pick). */
  readonly onPick?: () => void
}

/** Where the step points: its selector, else the screen of its recorded position. */
function placeText(step: WalkthroughStep, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (step.selector !== undefined && step.selector !== '') return step.selector
  const route = step.anchor?.route ?? ''
  return t('prototypeWalkthrough.position', { screen: route === '' ? t('prototypeWalkthrough.thisScreen') : route })
}

export default function WalkthroughStepCard({
  step, index, total, onChange, onMove, onRemove, onPreview, onDragStart, onDrop, onPick,
}: WalkthroughStepCardProps) {
  const { t } = useTranslation('components')
  const titleId = useId()
  const bodyId = useId()
  const number = index + 1
  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (!e.altKey || !e.shiftKey) return
    if (e.key === 'ArrowUp' && index > 0) { e.preventDefault(); onMove(index - 1) }
    if (e.key === 'ArrowDown' && index < total - 1) { e.preventDefault(); onMove(index + 1) }
  }
  const allowDrop = (e: DragEvent<HTMLLIElement>) => { e.preventDefault() }
  return (
    <li className="card p-3 space-y-2 min-w-0" draggable onDragStart={onDragStart} onDragOver={allowDrop}
      onDrop={(e) => { e.preventDefault(); onDrop() }} onKeyDown={onKey}
      aria-label={t('prototypeWalkthrough.stepLabel', { n: number, total })} data-testid={`walkthrough-step-${String(number)}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-strong">
          <GripVertical size={14} aria-hidden /> {t('prototypeWalkthrough.stepCount', { n: number, total })}
        </span>
        <div className="flex items-center gap-1">
          <button type="button" className="icon-btn p-1" disabled={index === 0} onClick={() => onMove(index - 1)}
            aria-label={t('prototypeWalkthrough.moveUp', { n: number })} title={t('prototypeWalkthrough.moveUp', { n: number })}>
            <ArrowUp size={14} aria-hidden />
          </button>
          <button type="button" className="icon-btn p-1" disabled={index === total - 1} onClick={() => onMove(index + 1)}
            aria-label={t('prototypeWalkthrough.moveDown', { n: number })} title={t('prototypeWalkthrough.moveDown', { n: number })}>
            <ArrowDown size={14} aria-hidden />
          </button>
          <button type="button" className="icon-btn p-1" onClick={onPreview}
            aria-label={t('prototypeWalkthrough.previewFrom', { n: number })} title={t('prototypeWalkthrough.previewFrom', { n: number })}>
            <Play size={14} aria-hidden />
          </button>
          <button type="button" className="icon-btn p-1 hover:text-danger" onClick={onRemove}
            aria-label={t('prototypeWalkthrough.removeStep', { n: number })} title={t('prototypeWalkthrough.removeStep', { n: number })}>
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      </div>
      <label htmlFor={titleId} className="block text-xs font-medium">{t('prototypeWalkthrough.title')}</label>
      <input id={titleId} className="input" value={step.title} maxLength={WALKTHROUGH_LIMITS.title}
        onChange={(e) => onChange({ ...step, title: e.target.value })} />
      <label htmlFor={bodyId} className="block text-xs font-medium">{t('prototypeWalkthrough.body')}</label>
      <textarea id={bodyId} className="input" rows={3} value={step.body} maxLength={WALKTHROUGH_LIMITS.body}
        onChange={(e) => onChange({ ...step, body: e.target.value })} />
      <p className="text-xs text-muted break-all">
        {t('prototypeWalkthrough.pointsAt')} <code>{placeText(step, t)}</code>
      </p>
      {step.check === true ? <p className="text-xs text-warn">{t('prototypeWalkthrough.checkPlace')}</p> : null}
      {onPick === undefined ? null : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onPick}>
          <Crosshair size={12} aria-hidden /> {t('prototypeWalkthrough.repoint', { n: number })}
        </button>
      )}
    </li>
  )
}
