/**
 * @fileoverview What a confirmed paste left out for its redaction (`redaction_unavailable`, 7.71.04,
 * docs/source-policies.md): the dialog returns to the paste step, its source URL kept, and says how many reviews were
 * imported and which were left out, each by its number in the list confirmed and its opening words (that list is
 * gone once imported), so those can be pasted again.
 *
 * @module pages/Scrapers/ManualImportLeftOut
 */
import { CheckCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import UnredactedRows from './UnredactedRows'

/** The notice's figures; `names` as `scraper-helpers.ts` `leftOutNames` reads them. */
export interface LeftOut {
  readonly imported: number
  readonly count: number
  readonly names: readonly string[]
}

export default function LeftOutNotice({ leftOut }: Readonly<{ leftOut: LeftOut }>) {
  const { t } = useTranslation('scrapers')
  return (
    <div>
      <p className="mb-2 text-sm text-ok flex items-center gap-1">
        <CheckCircle size={14} aria-hidden="true" /> {t('manualImport.imported', { count: leftOut.imported })}
      </p>
      <UnredactedRows count={leftOut.count} names={leftOut.names} noun="reviews" />
    </div>
  )
}
