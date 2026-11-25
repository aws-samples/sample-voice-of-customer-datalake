/**
 * @fileoverview The rows an upload left out because their personal data could not be checked (`redaction_unavailable`,
 * 7.71.04, docs/source-policies.md): the source redacts, its redaction is strict, and the redaction service could not
 * read them, so nothing of them was kept. Says how many, names the ones the answer named by their place in what was
 * sent ("rows 2, 5 and 9", "and 37 more" past those) and that sending just those again imports them. The CSV upload,
 * the JSON upload and the pasted reviews' result show it; the import wizard lists them with its other refusals.
 *
 * @module pages/Scrapers/UnredactedRows
 */
import { AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

/** What the left-out rows are called where they were sent: a CSV's rows, a JSON file's items, a paste's reviews. */
type Noun = 'rows' | 'items' | 'reviews'

function leftOut(t: TFunction<'scrapers'>, noun: Noun, count: number, list: string): string {
  switch (noun) {
    case 'rows': return t('unredacted.rowsLeftOut', { count, list })
    case 'items': return t('unredacted.itemsLeftOut', { count, list })
    case 'reviews': return t('unredacted.reviewsLeftOut', { count, list })
  }
}

export default function UnredactedRows({ count, names, noun }: Readonly<{
  /** How many were left out (the answer's whole count). */
  count: number
  /** The named ones as the person finds them (their numbers, a review with its opening words), at most `count`. */
  names: readonly string[]
  noun: Noun
}>) {
  const { t, i18n } = useTranslation('scrapers')
  if (count === 0) return null
  const more = count - names.length
  const list = new Intl.ListFormat(i18n.language, { type: 'conjunction' })
    .format(more > 0 ? [...names, t('unredacted.more', { count: more })] : names)
  return (
    <p role="status" className="flex items-start gap-1.5 text-left text-sm p-3 mb-3 bg-warn-subtle border border-warn/30 rounded-lg text-warn">
      <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span>{leftOut(t, noun, count, list)} {t('unredacted.sendAgain')}</span>
    </p>
  )
}
