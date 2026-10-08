/**
 * @fileoverview Time range selector dropdown component.
 *
 * Features:
 * - Preset ranges: 24h, 48h, 7d, 30d, 90d, All time (days=0)
 * - Custom "last N days" rolling lookback input: 1–9999 days, or 0 for all time
 * - Date-basis picker: filter by imported date (when data was collected) or
 *   review date (when the customer originally wrote the feedback)
 * - Persists selection to config store
 * - Mobile-responsive dropdown
 *
 * @module components/TimeRangeSelector
 */

import { useState, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useConfigStore } from '../../store/configStore'
import { ALL_TIME_CUSTOM_DAYS, MAX_CUSTOM_DAYS, parseCustomDaysInput } from '../../api/baseUrl'
import type { DateBasis } from '../../api/types'
import { Calendar, X, ChevronDown, Check } from 'lucide-react'
import clsx from 'clsx'
import { useOverlayFocus } from '../../hooks/useOverlayFocus'

/** ArrowUp/ArrowDown/Home/End move focus between a listbox's options (APG listbox). */
function moveOptionFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'))
  const current = options.findIndex((option) => option === document.activeElement)
  const last = options.length - 1
  const next: Record<string, number> = {
    ArrowDown: current >= last ? 0 : current + 1,
    ArrowUp: current <= 0 ? last : current - 1,
    Home: 0,
    End: last,
  }
  const target = next[event.key]
  if (target === undefined) return
  event.preventDefault()
  options[target]?.focus()
}

// Labels are `common:timeRange.*` keys, held in `labelKey`-shaped properties so
// scripts/i18n-check.mjs can see them through the table.
const ranges = [
  { value: '24h', labelKey: 'common:timeRange.24h', fullLabelKey: 'common:timeRange.24hFull' },
  { value: '48h', labelKey: 'common:timeRange.48h', fullLabelKey: 'common:timeRange.48hFull' },
  { value: '7d', labelKey: 'common:timeRange.7d', fullLabelKey: 'common:timeRange.7dFull' },
  { value: '30d', labelKey: 'common:timeRange.30d', fullLabelKey: 'common:timeRange.30dFull' },
  { value: '90d', labelKey: 'common:timeRange.90d', fullLabelKey: 'common:timeRange.90dFull' },
  { value: 'all', labelKey: 'common:timeRange.allShort', fullLabelKey: 'common:timeRange.allTime' },
  { value: 'custom', labelKey: 'common:timeRange.custom', fullLabelKey: 'common:timeRange.custom' },
] as const

// The two dates every feedback item carries. The time range window applies to
// whichever one is selected here.
interface DateBasisOption {
  value: DateBasis
  labelKey: string
  descriptionKey: string
  tooltipKey: string
}

/** The default basis, and the one shown should the store hold an unknown value. */
const IMPORTED_BASIS_OPTION: DateBasisOption = {
  value: 'imported',
  labelKey: 'common:timeRange.imported',
  descriptionKey: 'common:timeRange.importedDescription',
  tooltipKey: 'common:timeRange.importedTooltip',
}

const DATE_BASIS_OPTIONS: ReadonlyArray<DateBasisOption> = [
  IMPORTED_BASIS_OPTION,
  {
    value: 'review',
    labelKey: 'common:timeRange.review',
    descriptionKey: 'common:timeRange.reviewDescription',
    tooltipKey: 'common:timeRange.reviewTooltip',
  },
]
// Custom lookback: 1–MAX_CUSTOM_DAYS days, or 0 for all time, sent to the API
// as-is by `getDaysFromRange` (feedback is never deleted).

/** Header label of the applied custom range: "All time" for 0, "Last N days" otherwise. */
function customRangeLabel(customDays: number | null, t: TFunction): string | null {
  if (customDays == null) return null
  return customDays === ALL_TIME_CUSTOM_DAYS
    ? t('common:timeRange.allTime')
    : t('common:timeRange.lastNDays', { count: customDays })
}

export default function TimeRangeSelector() {
  const { t } = useTranslation()
  const { timeRange, setTimeRange, customDays, setCustomDays, dateBasis, setDateBasis } = useConfigStore()
  const [showPicker, setShowPicker] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [showBasisPicker, setShowBasisPicker] = useState(false)
  const [daysInput, setDaysInput] = useState(customDays == null ? '' : String(customDays))
  const pickerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const basisRef = useRef<HTMLDivElement>(null)
  const basisListRef = useRef<HTMLDivElement>(null)
  const dropdownMenuRef = useRef<HTMLDivElement>(null)

  // Keyboard contract of the three popups (design audit D-OVL): focus moves to the
  // current choice on open, Escape closes and puts focus back on the trigger, and
  // the two menus close when Tab leaves them instead of lingering over the page.
  useOverlayFocus(basisListRef, showBasisPicker, {
    onClose: () => setShowBasisPicker(false), initialFocus: '[aria-selected="true"]', closeOnFocusOut: true,
  })
  useOverlayFocus(dropdownMenuRef, showDropdown, {
    onClose: () => setShowDropdown(false), initialFocus: '[aria-pressed="true"]', closeOnFocusOut: true,
  })
  // Focus moves to the days input via initialFocus, not `autoFocus`: autoFocus fires
  // before the hook records the opener, so Escape could not return to the trigger.
  useOverlayFocus(pickerRef, showPicker, { onClose: () => setShowPicker(false), initialFocus: '#custom-days', closeOnFocusOut: true })

  // Close picker/dropdown when clicking outside, and every popup on Escape
  // (the menus are non-modal, so Escape is the keyboard user's only way out).
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target
      if (target instanceof Node) {
        if (pickerRef.current && !pickerRef.current.contains(target)) {
          setShowPicker(false)
        }
        if (dropdownRef.current && !dropdownRef.current.contains(target)) {
          setShowDropdown(false)
        }
        if (basisRef.current && !basisRef.current.contains(target)) {
          setShowBasisPicker(false)
        }
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setShowPicker(false)
      setShowDropdown(false)
      setShowBasisPicker(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [])

  const handleRangeClick = (value: typeof ranges[number]['value']) => {
    if (value === 'custom') {
      setDaysInput(customDays == null ? '' : String(customDays))
      setShowPicker(true)
      setShowDropdown(false)
    } else {
      setTimeRange(value)
      setCustomDays(null)
      setShowPicker(false)
      setShowDropdown(false)
    }
  }

  const parsedDays = parseCustomDaysInput(daysInput)

  const handleApplyCustom = () => {
    if (parsedDays !== null) {
      setCustomDays(parsedDays)
      setTimeRange('custom')
      setShowPicker(false)
    }
  }

  const handleClearCustom = () => {
    setCustomDays(null)
    setDaysInput('')
    setTimeRange('7d')
    setShowPicker(false)
  }

  const handleBasisSelect = (basis: DateBasis) => {
    setDateBasis(basis)
    setShowBasisPicker(false)
    setShowDropdown(false)
  }

  const currentBasis = DATE_BASIS_OPTIONS.find(o => o.value === dateBasis) ?? IMPORTED_BASIS_OPTION
  const currentBasisLabel = t(currentBasis.labelKey)
  const basisTooltip = t(currentBasis.tooltipKey)
  const filterByLabel = t('common:timeRange.filterBy')

  const customLabel = customRangeLabel(customDays, t)
  const currentRange = ranges.find(r => r.value === timeRange) ?? ranges[2]

  const getDisplayLabel = () => (timeRange === 'custom' && customLabel ? customLabel : t(currentRange.labelKey))
  const getCurrentFullLabel = () => (timeRange === 'custom' && customLabel ? customLabel : t(currentRange.fullLabelKey))

  return (
    <div className="relative flex items-center gap-2">
      {/* Desktop: date-basis picker (imported date vs review date) */}
      <div className="hidden sm:block relative" ref={basisRef}>
        <button
          type="button"
          onClick={() => setShowBasisPicker(!showBasisPicker)}
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted hover:text-text rounded-lg hover:bg-bg-hover transition-colors focus-ring"
          title={basisTooltip}
          aria-expanded={showBasisPicker}
          aria-haspopup="listbox"
          aria-label={t('common:timeRange.filterByCurrent', { basis: currentBasisLabel })}
        >
          <Calendar size={16} aria-hidden="true" />
          <span className="whitespace-nowrap">{currentBasisLabel}</span>
          <ChevronDown
            size={14}
            className={clsx('transition-transform', showBasisPicker && 'rotate-180')}
            aria-hidden="true"
          />
        </button>

        {showBasisPicker && (
          <div
            ref={basisListRef}
            className="menu absolute top-full left-0 mt-1 w-72"
            role="listbox"
            aria-label={filterByLabel}
            onKeyDown={moveOptionFocus}
          >
            <p className="menu-label" aria-hidden="true">
              {filterByLabel}
            </p>
            {DATE_BASIS_OPTIONS.map(({ value, labelKey, descriptionKey }) => {
              const selected = dateBasis === value
              return (
                <button
                  type="button"
                  key={value}
                  onClick={() => handleBasisSelect(value)}
                  role="option"
                  aria-selected={selected}
                  className={clsx(
                    'menu-item',
                    selected && 'bg-accent-subtle hover:bg-accent-subtle'
                  )}
                >
                  <span className="flex w-full items-start justify-between gap-2">
                    <span>
                      <span className={clsx(
                        'block text-[13px] font-medium',
                        selected ? 'text-accent-text' : 'text-text-strong'
                      )}>
                        {t(labelKey)}
                      </span>
                      {/* `text-text` on the accent-tinted selected row: `text-muted`
                          drops below 4.5:1 against bg-accent-subtle in dark mode. */}
                      <span className={clsx('block text-xs mt-0.5', selected ? 'text-text' : 'text-muted')}>
                        {t(descriptionKey)}
                      </span>
                    </span>
                    {selected && (
                      <Check size={16} className="text-accent flex-shrink-0 mt-0.5" aria-hidden="true" />
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      {/* Mobile: Dropdown selector */}
      <div className="sm:hidden relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setShowDropdown(!showDropdown)}
          className="flex items-center gap-2 px-3 py-2.5 bg-bg-elevated border border-border rounded-lg text-sm text-text active:bg-bg-hover touch-manipulation min-h-[44px] focus-ring"
          aria-expanded={showDropdown}
          aria-haspopup="true"
          aria-label={`${t('common:timeRange.label')}: ${getCurrentFullLabel()}`}
          title={basisTooltip}
        >
          <Calendar size={16} className="text-muted flex-shrink-0" aria-hidden="true" />
          <span className="truncate max-w-[100px]">{getDisplayLabel()}</span>
          <ChevronDown size={16} className={clsx('transition-transform flex-shrink-0', showDropdown && 'rotate-180')} aria-hidden="true" />
        </button>

        {showDropdown && (
          // Plain toggle-button groups rather than a listbox: the panel mixes two
          // independent choices (range + date basis), which a single listbox
          // cannot express (axe aria-required-children).
          <div ref={dropdownMenuRef} className="menu absolute top-full right-0 mt-1 min-w-[220px]">
            <div role="group" aria-label={t('common:timeRange.label')}>
              {ranges.map(({ value, fullLabelKey }) => {
                const selected = timeRange === value
                return (
                  <button
                    type="button"
                    key={value}
                    onClick={() => handleRangeClick(value)}
                    aria-pressed={selected}
                    className={clsx(
                      'menu-item justify-between py-3 touch-manipulation active:bg-bg-hover',
                      selected && 'bg-accent-subtle text-accent-text hover:bg-accent-subtle'
                    )}
                  >
                    {value === 'custom' && customLabel ? customLabel : t(fullLabelKey)}
                    {selected && <Check size={16} className="flex-shrink-0" aria-hidden="true" />}
                  </button>
                )
              })}
            </div>
            {/* Date-basis section (imported date vs review date) */}
            <div className="menu-separator" aria-hidden="true" />
            <div role="group" aria-label={filterByLabel}>
              <p className="menu-label" aria-hidden="true">
                {filterByLabel}
              </p>
              {DATE_BASIS_OPTIONS.map(({ value, labelKey }) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => handleBasisSelect(value)}
                  aria-pressed={dateBasis === value}
                  className={clsx(
                    'menu-item justify-between py-3 touch-manipulation active:bg-bg-hover',
                    dateBasis === value && 'bg-accent-subtle text-accent-text hover:bg-accent-subtle'
                  )}
                >
                  {t(labelKey)}
                  {dateBasis === value && <Check size={16} className="flex-shrink-0" aria-hidden="true" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Desktop: Button group */}
      <div className="tabs-track hidden sm:flex" role="group" aria-label={t('common:timeRange.label')}>
        {ranges.map(({ value, labelKey }) => (
          <button
            type="button"
            key={value}
            onClick={() => handleRangeClick(value)}
            aria-pressed={timeRange === value}
            className={clsx(
              'tab',
              timeRange === value && 'tab-active'
            )}
          >
            {value === 'custom' && customLabel ? customLabel : t(labelKey)}
          </button>
        ))}
      </div>

      {/* Custom "last N days" picker. Anchored under the selector at every
          width (6rem clears the theme toggle to its right on a phone): a `fixed`
          bottom sheet resolved against the header's
          backdrop-filter containing block and rendered off-screen at 390px. */}
      {showPicker && (
        <div
          ref={pickerRef}
          className="menu absolute top-full right-0 mt-2 p-4 w-[calc(100vw-6rem)] max-w-[320px] sm:w-auto sm:min-w-[280px]"
          role="dialog"
          aria-label={t('common:timeRange.customRange')}
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t('common:timeRange.customRange')}</h3>
            <button
              type="button"
              onClick={() => setShowPicker(false)}
              className="icon-btn focus-ring -m-1.5 touch-manipulation"
              aria-label={t('common:timeRange.closeCustom')}
              title={t('common:timeRange.closeCustom')}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <div>
            <label htmlFor="custom-days" className="block text-sm text-text mb-1.5">
              {t('common:timeRange.lastNDaysInput')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="custom-days"
                type="number"
                inputMode="numeric"
                min={ALL_TIME_CUSTOM_DAYS}
                max={MAX_CUSTOM_DAYS}
                value={daysInput}
                onChange={(e) => setDaysInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleApplyCustom() }}
                placeholder={t('common:timeRange.customPlaceholder')}
                aria-describedby="custom-days-hint"
                className="input font-mono py-2.5 sm:py-2 text-base sm:text-sm"
              />
              <span className="text-sm text-muted whitespace-nowrap">{t('common:timeRange.daysUnit')}</span>
            </div>
            <p id="custom-days-hint" className="mt-1.5 text-xs text-muted">
              {t('common:timeRange.customHint', { max: MAX_CUSTOM_DAYS })}
            </p>
          </div>

          <div className="flex items-center justify-between mt-4 pt-4 border-t border-border gap-2">
            {customDays != null && (
              <button
                type="button"
                onClick={handleClearCustom}
                className="btn btn-ghost text-danger hover:text-danger touch-manipulation"
              >
                {t('common:timeRange.clear')}
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button
                type="button"
                onClick={() => setShowPicker(false)}
                className="btn btn-ghost py-2.5 sm:py-1.5 touch-manipulation"
              >
                {t('common:timeRange.cancel')}
              </button>
              <button
                type="button"
                onClick={handleApplyCustom}
                disabled={parsedDays === null}
                className="btn btn-primary py-2.5 sm:py-1.5 touch-manipulation"
              >
                {t('common:timeRange.apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
