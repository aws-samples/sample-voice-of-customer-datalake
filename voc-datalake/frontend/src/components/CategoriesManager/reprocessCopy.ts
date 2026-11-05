/**
 * @fileoverview Copy tables of the reprocess panel and its job progress, shared by both.
 *
 * Labels that vary by value are held in `*Key` table properties with their namespace,
 * so scripts/i18n-check.mjs can see them (it cannot read a template literal key).
 *
 * @module components/CategoriesManager/reprocessCopy
 */
import type { TFunction } from 'i18next'
import { ALL_TIME_CUSTOM_DAYS } from '../../api/baseUrl'
import type { ReprocessJob, ReprocessJobStatus, ReprocessMode } from '../../api/reprocessApi'
import type { Tone } from '../../theme/tones'

/** Copy per mode; a Record, so every mode the API accepts must have a title. */
export const MODE_COPY: Record<ReprocessMode, { titleKey: string; descriptionKey: string }> = {
  processed: {
    titleKey: 'components:categoriesManager.reprocess.modes.processed.title',
    descriptionKey: 'components:categoriesManager.reprocess.modes.processed.description',
  },
  raw: {
    titleKey: 'components:categoriesManager.reprocess.modes.raw.title',
    descriptionKey: 'components:categoriesManager.reprocess.modes.raw.description',
  },
  dimensions: {
    titleKey: 'components:categoriesManager.reprocess.modes.dimensions.title',
    descriptionKey: 'components:categoriesManager.reprocess.modes.dimensions.description',
  },
}

/** Display order of the mode choices. */
const MODE_ORDER: readonly ReprocessMode[] = ['processed', 'raw', 'dimensions']
export const MODES: ReadonlyArray<{ value: ReprocessMode; titleKey: string; descriptionKey: string }> =
  MODE_ORDER.map((value) => ({ value, ...MODE_COPY[value] }))

export const STATUS: Record<ReprocessJobStatus, { tone: Tone; labelKey: string }> = {
  queued: { tone: 'muted', labelKey: 'components:categoriesManager.reprocess.status.queued' },
  running: { tone: 'info', labelKey: 'components:categoriesManager.reprocess.status.running' },
  completed: { tone: 'ok', labelKey: 'components:categoriesManager.reprocess.status.completed' },
  partial: { tone: 'warn', labelKey: 'components:categoriesManager.reprocess.status.partial' },
  failed: { tone: 'danger', labelKey: 'components:categoriesManager.reprocess.status.failed' },
  cancelled: { tone: 'warn', labelKey: 'components:categoriesManager.reprocess.status.cancelled' },
}

type CounterField = 'scanned' | 'updated' | 'unchanged' | 'skipped_manual' | 'failed'

export const COUNTERS: ReadonlyArray<{ field: CounterField; labelKey: string }> = [
  { field: 'scanned', labelKey: 'components:categoriesManager.reprocess.counters.scanned' },
  { field: 'updated', labelKey: 'components:categoriesManager.reprocess.counters.updated' },
  { field: 'unchanged', labelKey: 'components:categoriesManager.reprocess.counters.unchanged' },
  { field: 'skipped_manual', labelKey: 'components:categoriesManager.reprocess.counters.skipped_manual' },
  { field: 'failed', labelKey: 'components:categoriesManager.reprocess.counters.failed' },
]

export function modeTitleKey(mode: ReprocessMode): string {
  return MODE_COPY[mode].titleKey
}

/** A `days` window: all time or the last N days. */
export function daysLabel(days: number, t: TFunction): string {
  return days === ALL_TIME_CUSTOM_DAYS
    ? t('components:categoriesManager.reprocess.allTime')
    : t('components:categoriesManager.reprocess.lastNDays', { count: days })
}

/** A job's window: its date range (with the date it reads) or its days. */
export function jobWindowLabel(
  job: Pick<ReprocessJob, 'days' | 'date_from' | 'date_to' | 'date_basis'>, t: TFunction,
): string {
  if (job.date_from === undefined && job.date_to === undefined) return daysLabel(job.days, t)
  const open = t('components:categoriesManager.reprocess.openEnded')
  const range = t('components:categoriesManager.reprocess.dateRange', {
    from: job.date_from ?? open, to: job.date_to ?? open,
  })
  return job.date_basis === 'review'
    ? t('components:categoriesManager.reprocess.byReviewDate', { range })
    : t('components:categoriesManager.reprocess.byProcessedDate', { range })
}
