/**
 * @fileoverview The fixed row list of the connector approval cards: one row per
 * saved field, in a fixed order, each with a `compare` string so an update can
 * diff before → after row by row (`./FieldDiff` renders them).
 *
 * @module assistant/approvals/previews/scraperRows
 */
import type { ReactNode } from 'react'
import { APP_ID_FIELD, SELECTOR_KEYS, appConnectorRecord, scraperFingerprint } from '../scraperSchemas'
import type { CreateAppConnectorArgs } from '../scraperSchemas'
import type { ScraperConfig } from '../../../api/types'
import type { FieldRow } from './FieldDiff'
import { Code, Lines, Muted, UrlLine } from './ScraperValues'

type Translate = (key: string, options?: Record<string, unknown>) => string

const K = 'assistantTools:preview.scraper'

/** Brand key → label (GET /radar/brands); a key without a label shows as the key. */
export type RadarLabels = ReadonlyMap<string, string>
const NO_LABELS: RadarLabels = new Map()

/** "Radar source": the brand whose Radar the reviews go to, or "No — our own feedback". */
function radarRow(key: string | undefined, labels: RadarLabels, t: Translate): FieldRow {
  const value = key === undefined || key === ''
    ? <Muted text={t(`${K}.radarNone`)} />
    : <strong className="font-semibold text-text-strong">{labels.get(key) ?? key}</strong>
  return row('radar_brand', t(`${K}.fields.radar_brand`), value, key ?? '')
}

const scheduleText = (minutes: number, t: Translate) => (minutes === 0 ? t(`${K}.scheduleOff`) : t(`${K}.scheduleEvery`, { n: minutes }))

function paginationText(pagination: ScraperConfig['pagination'], t: Translate): string {
  if (!pagination.enabled) return t(`${K}.paginationOff`)
  return t(`${K}.paginationOn`, { param: pagination.param, pages: pagination.max_pages, start: pagination.start })
}

function row(key: string, label: string, value: ReactNode, compare: unknown): FieldRow {
  // Key-order independent, so a map stored in another order is not reported as changed.
  return { key, label, value, compare: scraperFingerprint(compare ?? null) }
}

/** A row only a technical reader needs (the card shows it under "Details"). */
function technicalRow(key: string, label: string, value: ReactNode, compare: unknown): FieldRow {
  return { ...row(key, label, value, compare), technical: true }
}

function labelRows(record: ScraperConfig, t: Translate): FieldRow[] {
  const none = t(`${K}.none`)
  const dims = Object.entries(record.dimension_defaults ?? {})
  const tags = record.tags ?? []
  return [
    row('dimension_defaults', t(`${K}.fields.dimension_defaults`),
      <Lines items={dims.map(([key, value]) => `${key} = ${value}`)} empty={none} />, record.dimension_defaults),
    row('tags', t(`${K}.fields.tags`), tags.length === 0 ? <Muted text={none} /> : tags.join(', '), record.tags),
  ]
}

/** Every field a scraper save writes, in a fixed order. */
export function scraperRows(record: ScraperConfig, t: Translate, radarLabels: RadarLabels = NO_LABELS): FieldRow[] {
  const urls = [record.base_url, ...record.urls].filter((url) => url !== '')
  const notSet = <Muted text={t(`${K}.notSet`)} />
  const selectorRows = SELECTOR_KEYS.map((key) => {
    const value = record[key] ?? ''
    return technicalRow(key, t(`${K}.fields.${key}`), value === '' ? notSet : <Code text={value} />, value)
  })
  return [
    technicalRow('id', t(`${K}.fields.id`), <Code text={record.id} />, record.id),
    row('name', t(`${K}.fields.name`), record.name, record.name),
    row('urls', t(`${K}.fields.urls`), <Lines items={urls.map((url) => <UrlLine key={url} url={url} />)} empty={t(`${K}.none`)} />, urls),
    technicalRow('extraction_method', t(`${K}.fields.extraction_method`), t(`${K}.method.${record.extraction_method ?? 'jsonld'}`), record.extraction_method),
    ...selectorRows,
    technicalRow('pagination', t(`${K}.fields.pagination`), paginationText(record.pagination, t), record.pagination),
    row('frequency_minutes', t(`${K}.fields.schedule`), scheduleText(record.frequency_minutes, t), record.frequency_minutes),
    row('enabled', t(`${K}.fields.enabled`), record.enabled ? t('assistantTools:preview.yes') : t('assistantTools:preview.no'), record.enabled),
    radarRow(record.radar_brand, radarLabels, t),
    ...labelRows(record, t),
  ]
}

/** web_reviews bounds: "10 pages" / "All pages" (0), "Up to 200 reviews" / "No review limit" (0). */
function webBoundRows(record: Record<string, string>, t: Translate): FieldRow[] {
  const pages = record.max_pages ?? ''
  const reviews = record.max_reviews ?? ''
  return [
    row('max_pages', t(`${K}.fields.max_pages`), pages === '0' ? t(`${K}.pagesAll`) : t(`${K}.pagesN`, { n: pages }), pages),
    row('max_reviews', t(`${K}.fields.max_reviews`), reviews === '0' ? t(`${K}.reviewsUnlimited`) : t(`${K}.reviewsN`, { n: reviews }), reviews),
  ]
}

/** Every field an app-connector save writes (`appConnectorRecord`), in a fixed order. */
export function appRows(args: CreateAppConnectorArgs, t: Translate, radarLabels: RadarLabels = NO_LABELS): FieldRow[] {
  const record = appConnectorRecord(args)
  const idField = APP_ID_FIELD[args.source]
  const identifier = record[idField] ?? ''
  const bound = args.source === 'web_reviews'
    ? webBoundRows(record, t)
    : [
        row('sort_by', t(`${K}.fields.sort_by`), t(`${K}.sort.${record.sort_by ?? ''}`), record.sort_by),
        row('max_reviews_per_run', t(`${K}.fields.max_reviews_per_run`), record.max_reviews_per_run, record.max_reviews_per_run),
      ]
  return [
    row('source', t(`${K}.fields.store`), t(`${K}.store.${args.source}`), args.source),
    row('app_name', t(`${K}.fields.app_name`), record.app_name, record.app_name),
    technicalRow(idField, t(`${K}.fields.${idField}`), <Code text={identifier} />, identifier),
    ...bound,
    row('frequency_minutes', t(`${K}.fields.schedule`), scheduleText(Number(record.frequency_minutes), t), record.frequency_minutes),
    radarRow(record.radar_brand, radarLabels, t),
  ]
}
