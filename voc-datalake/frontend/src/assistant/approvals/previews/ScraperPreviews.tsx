/**
 * @fileoverview Approval previews of the connector write tools. Deterministic:
 * every row is computed from the validated args (and, for an update, the
 * stored scraper read fresh at render) — no model-written prose. The table is
 * the record the executor saves (`scraperSchemas.ts` builds both); the table
 * and diff components themselves are the shared ones in `./FieldDiff`.
 *
 * - create_scraper: a fixed table of every saved field;
 * - update_scraper: the same rows as before → after, unchanged rows collapsed;
 *   the fingerprint of the scraper it diffed against goes on the shown record,
 *   so the executor refuses if the scraper changed before approval;
 * - create_app_connector: the app config that is saved.
 *
 * @module assistant/approvals/previews/ScraperPreviews
 */
import { useContext, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchScraper } from '../scraperExecutors'
import { ShownContext, recordScraperBase } from '../shown'
import { FieldDiff, FieldTable, NothingSavedNote } from './FieldDiff'
import { appRows, scraperRows } from './scraperRows'
import { useRadarBrandLabels } from './useRadarBrands'
import {
  createdScraperRecord, mergedScraperRecord, scraperFingerprint,
} from '../scraperSchemas'
import type { CreateAppConnectorArgs, CreateScraperArgs, UpdateScraperArgs } from '../scraperSchemas'

export function ScraperCreatePreview({ args }: Readonly<{ args: CreateScraperArgs }>) {
  const { t } = useTranslation('assistantTools')
  const labels = useRadarBrandLabels()
  const rows = scraperRows(createdScraperRecord(args), t, labels)
  return (
    <div className="space-y-2">
      <FieldTable rows={rows} label={t('preview.scraper.savedFields')} />
      <NothingSavedNote />
    </div>
  )
}

export function ScraperUpdatePreview({ args }: Readonly<{ args: UpdateScraperArgs }>) {
  const { t } = useTranslation('assistantTools')
  const shown = useContext(ShownContext)
  const labels = useRadarBrandLabels()
  // Card-local key, fetched fresh: the diff must be against the stored scraper now.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['assistant', 'scraper-preview', args.scraper_id],
    queryFn: () => fetchScraper(args.scraper_id),
    retry: false,
    staleTime: 0,
  })
  useEffect(() => {
    if (shown !== null) recordScraperBase(shown, data === undefined ? undefined : scraperFingerprint(data))
  }, [shown, data])
  if (isLoading) return <p className="text-[12px] text-muted">{t('preview.loading')}</p>
  if (isError || data === undefined) {
    return <p role="alert" className="text-[12px] text-danger">{t('preview.scraper.notFound', { id: args.scraper_id })}</p>
  }
  return (
    <div className="space-y-2">
      <FieldDiff beforeRows={scraperRows(data, t, labels)} afterRows={scraperRows(mergedScraperRecord(data, args.updates), t, labels)} />
      <NothingSavedNote />
    </div>
  )
}

export function AppConnectorPreview({ args }: Readonly<{ args: CreateAppConnectorArgs }>) {
  const { t } = useTranslation('assistantTools')
  const labels = useRadarBrandLabels()
  return (
    <div className="space-y-2">
      <FieldTable rows={appRows(args, t, labels)} label={t('preview.scraper.savedFields')} />
      <NothingSavedNote />
    </div>
  )
}
