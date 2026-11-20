/**
 * @fileoverview Results' Download (7.61.00, docs/feedback-forms.md "Results and responses"): the responses under the
 * view's filters as the familiar CSV (Excel and Sheets open it with its accents, one header row, choices joined with
 * `;`), and from its menu the detailed layout (7.55.00's, for scripts) or the familiar one with a row of ids. The file
 * is named `<form-name-slug>-responses-<yyyy-mm-dd>.csv`.
 *
 * @module pages/FeedbackForms/results/DownloadButton
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { ResultsFilters } from '../../../api/feedbackFormsV2Api'
import { FAMILIAR_CSV, csvFilename } from '../../../api/feedbackFormsCsv'
import type { CsvChoice } from '../../../api/feedbackFormsCsv'
import { useDraft } from '../builder/formDraftContext'
import ActionsMenu from '../ui/ActionsMenu'

/** Download the CSV `choice` names under the filters, as the answer names it (else by the server's rule). */
async function saveCsv(formId: string, name: string, filters: ResultsFilters, choice: CsvChoice): Promise<void> {
  const file = await feedbackFormsV2Api.downloadResponsesCsv(formId, filters, choice)
  const url = URL.createObjectURL(file.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename ?? csvFilename(name, formId, choice.layout)
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function DownloadButton({ formId, filters }: Readonly<{ formId: string; filters: ResultsFilters }>) {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = async (choice: CsvChoice) => {
    setBusy(true)
    setFailed(false)
    try {
      await saveCsv(formId, form.name, filters, choice)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="flex items-center gap-1">
      {failed && <span role="alert" className="mr-1 text-[12px] text-danger">{t('results.csvFailed')}</span>}
      <button type="button" className="btn btn-secondary btn-sm" aria-busy={busy} disabled={busy} onClick={() => { void run(FAMILIAR_CSV) }}>
        <Download size={14} aria-hidden="true" />{t('results.download')}
      </button>
      <ActionsMenu label={t('results.downloadOptions')} items={[
        { label: t('results.downloadDetailed'), onSelect: () => { void run({ layout: 'detailed', ids: false }) } },
        { label: t('results.downloadWithIds'), onSelect: () => { void run({ layout: 'familiar', ids: true }) } },
      ]} />
    </span>
  )
}
