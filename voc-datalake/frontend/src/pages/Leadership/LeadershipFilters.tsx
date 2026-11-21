/**
 * @fileoverview The leadership view's filter row (dataviz: filters in one row above the charts): the range, the
 * grain (month or quarter), the assumptions drawer and the CSV export.
 * @module pages/Leadership/LeadershipFilters
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Info } from 'lucide-react'
import { GRAINS } from '../../api/adoptionApi'
import type { Grain } from '../../api/adoptionApi'
import { RANGE_PRESETS } from './leadershipRange'
import type { RangePreset } from './leadershipRange'

interface LeadershipFiltersProps {
  readonly preset: RangePreset
  readonly grain: Grain
  readonly onPreset: (preset: RangePreset) => void
  readonly onGrain: (grain: Grain) => void
  readonly onAssumptions: () => void
  /** Absent until the view has loaded. */
  readonly onCsv?: () => void
}

const isPreset = (value: string): value is RangePreset => RANGE_PRESETS.some((preset) => preset === value)

export default function LeadershipFilters({ preset, grain, onPreset, onGrain, onAssumptions, onCsv }: LeadershipFiltersProps) {
  const { t } = useTranslation('leadership')
  const grainLabel = useId()
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">{t('filters.range')}</span>
        <select className="input" value={preset} onChange={(event) => {
          if (isPreset(event.target.value)) onPreset(event.target.value)
        }}>
          {RANGE_PRESETS.map((value) => <option key={value} value={value}>{t(`filters.presets.${value}`)}</option>)}
        </select>
      </label>
      <div className="flex flex-col gap-1 text-sm">
        <span id={grainLabel} className="text-muted">{t('filters.grain')}</span>
        <div className="flex gap-1" role="group" aria-labelledby={grainLabel}>
          {GRAINS.map((value) => (
            <button key={value} type="button" aria-pressed={grain === value}
              className={grain === value ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              onClick={() => onGrain(value)}>
              {t(`filters.grains.${value}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2 sm:ml-auto sm:self-end">
        <button type="button" className="btn btn-secondary" onClick={onAssumptions}>
          <Info size={16} aria-hidden="true" />{t('filters.assumptions')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCsv} disabled={onCsv === undefined}>
          <Download size={16} aria-hidden="true" />{t('filters.csv')}
        </button>
      </div>
    </div>
  )
}
