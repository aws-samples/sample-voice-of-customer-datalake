/**
 * @fileoverview The slice a reprocess job replays (TENETS.md D3): the window (last N days or a
 * date range on the processed or the review date), the sources, the categories, and whether
 * manual corrections are overwritten.
 *
 * Sources are the ones the server knows to have data (`GET /settings/erasure` → `sources`, the
 * list the source erasure picker uses); categories are typed, so a category that is no longer
 * configured (the usual reason to reprocess) can still be named.
 *
 * @module components/CategoriesManager/ReprocessSliceFields
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { ALL_TIME_CUSTOM_DAYS, MAX_CUSTOM_DAYS } from '../../api/baseUrl'
import type { ReprocessDateBasis } from '../../api/reprocessApi'
import { useErasableSources } from '../SourcesManager/useErasureJobs'
import type { ReprocessForm, WindowKind } from './reprocessForm'

type Change = (patch: Partial<ReprocessForm>) => void

const WINDOW_KINDS: ReadonlyArray<{ value: WindowKind; labelKey: string }> = [
  { value: 'days', labelKey: 'components:categoriesManager.reprocess.windowDays' },
  { value: 'range', labelKey: 'components:categoriesManager.reprocess.windowRange' },
]

const DATE_BASES: ReadonlyArray<{ value: ReprocessDateBasis; labelKey: string }> = [
  { value: 'processed', labelKey: 'components:categoriesManager.reprocess.basisProcessed' },
  { value: 'review', labelKey: 'components:categoriesManager.reprocess.basisReview' },
]

function isDateBasis(value: string): value is ReprocessDateBasis {
  return DATE_BASES.some((basis) => basis.value === value)
}

function DaysField({ form, onChange, invalid }: Readonly<{ form: ReprocessForm; onChange: Change; invalid: boolean }>) {
  const { t } = useTranslation('components')
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.daysLabel')}</label>
      <input
        id={id} type="number" inputMode="numeric" min={ALL_TIME_CUSTOM_DAYS} max={MAX_CUSTOM_DAYS}
        value={form.daysInput} onChange={(e) => onChange({ daysInput: e.target.value })}
        aria-invalid={invalid} className="input font-mono py-1.5 w-32"
      />
      <p className="text-xs text-muted mt-1">{t('categoriesManager.reprocess.daysHint', { max: MAX_CUSTOM_DAYS })}</p>
    </div>
  )
}

function RangeFields({ form, onChange, invalid }: Readonly<{ form: ReprocessForm; onChange: Change; invalid: boolean }>) {
  const { t } = useTranslation('components')
  const fromId = useId()
  const toId = useId()
  const basisId = useId()
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor={fromId} className="block text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.dateFrom')}</label>
        <input id={fromId} type="date" value={form.dateFrom} max={form.dateTo || undefined} aria-invalid={invalid}
          onChange={(e) => onChange({ dateFrom: e.target.value })} className="input py-1.5" />
      </div>
      <div>
        <label htmlFor={toId} className="block text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.dateTo')}</label>
        <input id={toId} type="date" value={form.dateTo} min={form.dateFrom || undefined} aria-invalid={invalid}
          onChange={(e) => onChange({ dateTo: e.target.value })} className="input py-1.5" />
      </div>
      <div>
        <label htmlFor={basisId} className="block text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.dateBasis')}</label>
        <select id={basisId} value={form.dateBasis} className="select"
          onChange={(e) => { if (isDateBasis(e.target.value)) onChange({ dateBasis: e.target.value }) }}>
          {DATE_BASES.map((basis) => <option key={basis.value} value={basis.value}>{t(basis.labelKey)}</option>)}
        </select>
      </div>
      <p className="text-xs text-muted w-full">{t('categoriesManager.reprocess.rangeHint')}</p>
    </div>
  )
}

function SourcePicker({ selected, onChange }: Readonly<{ selected: readonly string[]; onChange: Change }>) {
  const { t } = useTranslation('components')
  const { data: sources = [] } = useErasableSources()
  if (sources.length === 0) return null
  const toggle = (source: string, on: boolean) =>
    onChange({ sources: on ? [...selected, source] : selected.filter((value) => value !== source) })
  return (
    <fieldset>
      <legend className="text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.sourcesLabel')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {sources.map((source) => (
          <label key={source} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(source)} className="rounded-sm accent-accent"
              onChange={(e) => toggle(source, e.target.checked)} />
            <span className="font-mono text-xs text-text">{source}</span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted mt-1">{t('categoriesManager.reprocess.sourcesHint')}</p>
    </fieldset>
  )
}

export default function ReprocessSliceFields({ form, onChange, invalid }: Readonly<{
  form: ReprocessForm
  onChange: Change
  invalid: boolean
}>) {
  const { t } = useTranslation('components')
  const categoriesId = useId()
  return (
    <div className="space-y-3">
      <fieldset className="flex flex-wrap gap-4">
        <legend className="text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.windowLabel')}</legend>
        {WINDOW_KINDS.map((kind) => (
          <label key={kind.value} className="flex items-center gap-2 text-sm">
            <input type="radio" name="reprocess-window" value={kind.value} checked={form.windowKind === kind.value}
              onChange={() => onChange({ windowKind: kind.value })} className="accent-accent" />
            <span className="text-text">{t(kind.labelKey)}</span>
          </label>
        ))}
      </fieldset>
      {form.windowKind === 'days'
        ? <DaysField form={form} onChange={onChange} invalid={invalid} />
        : <RangeFields form={form} onChange={onChange} invalid={invalid} />}
      <SourcePicker selected={form.sources} onChange={onChange} />
      <div>
        <label htmlFor={categoriesId} className="block text-xs font-medium text-text-strong mb-1">{t('categoriesManager.reprocess.categoriesLabel')}</label>
        <input id={categoriesId} type="text" value={form.categoriesInput} className="input py-1.5 w-full max-w-md"
          onChange={(e) => onChange({ categoriesInput: e.target.value })}
          placeholder={t('categoriesManager.reprocess.categoriesPlaceholder')} />
        <p className="text-xs text-muted mt-1">{t('categoriesManager.reprocess.categoriesHint')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm min-h-9">
        <input type="checkbox" checked={form.includeManual} className="rounded-sm accent-accent"
          onChange={(e) => onChange({ includeManual: e.target.checked })} />
        <span className="text-text">{t('categoriesManager.reprocess.includeManual')}</span>
      </label>
    </div>
  )
}
