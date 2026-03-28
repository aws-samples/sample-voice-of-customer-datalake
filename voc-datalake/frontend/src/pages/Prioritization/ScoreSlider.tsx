/**
 * @fileoverview Score slider component for prioritization scoring.
 * @module pages/Prioritization/ScoreSlider
 */

import clsx from 'clsx'
import { getScoreColor } from './prioritizationUtils'

interface ScoreSliderProps {
  readonly label: string
  readonly value: number
  readonly onChange: (v: number) => void
  readonly description?: string
  readonly lowLabel?: string
  readonly highLabel?: string
  readonly inverted?: boolean
}

export default function ScoreSlider({
  label, value, onChange, description, lowLabel = '1', highLabel = '5', inverted = false,
}: ScoreSliderProps) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        <span className={clsx('text-sm font-bold px-2 py-0.5 rounded', getScoreColor(inverted ? 6 - value : value))}>{value}</span>
      </div>
      {description != null && description !== '' ? <p className="text-xs text-gray-500">{description}</p> : null}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 w-16">{lowLabel}</span>
        <input type="range" min={1} max={5} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600" />
        <span className="text-xs text-gray-400 w-16 text-right">{highLabel}</span>
      </div>
    </div>
  )
}
