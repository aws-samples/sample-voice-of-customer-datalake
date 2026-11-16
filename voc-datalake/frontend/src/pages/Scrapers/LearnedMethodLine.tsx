/**
 * @fileoverview What this workspace learned for an Automatic review page's site ("Known best: Bedrock web index
 * (learned 15 Nov 2026)", and for a site another method reads when the browser is tried again), and "Re-check
 * methods" for its admins: the site's record is cleared, so the next run tries
 * every method again (useLearnedMethods.ts). Nothing before a run learned anything.
 * @module pages/Scrapers/LearnedMethodLine
 */
import { Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { formatDate } from '../../utils/dateUtils'
import { STEP_KEYS } from './reviewReads'
import type { LearnedMethod } from './useLearnedMethods'
import type { WebReviewMethodRecord } from '../../api/webReviewMethodsApi'

function LearnedText({ record }: Readonly<{ record: WebReviewMethodRecord }>) {
  const { t, i18n } = useTranslation('scrapers')
  if (record.best_method === 'none') return <span>{t('appCard.learned.none')}</span>
  const method = t(STEP_KEYS[record.best_method])
  const date = formatDate(record.learned_at, i18n.language)
  const recheck = formatDate(record.browser_recheck_due_at, i18n.language)
  return (
    <>
      <span>{date === '' ? t('appCard.learned.bestUndated', { method }) : t('appCard.learned.best', { method, date })}</span>
      {recheck === '' ? null : <span className="text-muted">{t('appCard.learned.browserRecheck', { date: recheck })}</span>}
    </>
  )
}

export default function LearnedMethodLine({ learned, isAdmin }: Readonly<{ learned: LearnedMethod; isAdmin: boolean }>) {
  const { t } = useTranslation('scrapers')
  const { record, cleared, pending, failed, onRecheck } = learned
  if (record === undefined) {
    return cleared ? <p className="mt-2 text-xs text-muted" role="status">{t('appCard.learned.cleared')}</p> : null
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text">
      <LearnedText record={record} />
      <button type="button" onClick={onRecheck} disabled={!isAdmin || pending}
        title={isAdmin ? t('appCard.learned.recheckTitle') : ADMIN_ONLY_TITLE} className="btn btn-ghost btn-sm">
        {pending ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
        {t('appCard.learned.recheck')}
      </button>
      {failed ? <span className="text-danger" role="alert">{t('appCard.learned.recheckFailed')}</span> : null}
    </div>
  )
}
