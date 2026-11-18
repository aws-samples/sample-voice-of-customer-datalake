/**
 * @fileoverview The full-screen preview, `/feedback-forms/<id>/preview` (UX §3.5): the stored form in the real
 * widget, full width, which never submits; Back to the builder.
 *
 * @module pages/FeedbackForms/preview/FullScreenPreview
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { languageNames } from '../../../i18n/languages'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import type { FormLanguage } from '../model/formsV2'
import { builderPath } from '../builder/builderPaths'
import PreviewFrame from './PreviewFrame'

export default function FullScreenPreview({ formId }: Readonly<{ formId: string }>) {
  const { t } = useTranslation('feedbackForms')
  const stored = useQuery({ queryKey: ['feedback-forms', 'v2', formId], queryFn: () => feedbackFormsV2Api.getForm(formId) })
  const [chosen, setChosen] = useState<FormLanguage | null>(null)
  const back = (
    <Link to={builderPath(formId, 'questions')} className="btn btn-ghost btn-sm">
      <ChevronLeft size={14} aria-hidden="true" />{t('preview.backToBuilder')}
    </Link>
  )
  if (stored.isError) return <div className="space-y-3">{back}<LoadFailed onRetry={() => void stored.refetch()} retrying={stored.isFetching} /></div>
  if (stored.data === undefined) return <div className="space-y-3">{back}<p role="status" className="text-sm text-muted">{t('preview.loading')}</p></div>
  const { form } = stored.data
  const language = chosen !== null && form.languages.includes(chosen) ? chosen : form.language
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        {form.languages.length > 1 && (
          <select aria-label={t('preview.language')} className="select select-sm w-auto" value={language}
            onChange={(event) => setChosen(form.languages.find((lng) => lng === event.target.value) ?? null)}>
            {form.languages.map((lng) => <option key={lng} value={lng}>{languageNames[lng]}</option>)}
          </select>
        )}
      </div>
      <PreviewFrame form={form} language={language} device="desktop"
        title={t('preview.frameTitle', { size: t('preview.device.desktop'), language: languageNames[language] })} />
      <p className="text-[12px] text-muted">{t('preview.nothingSent')}</p>
    </div>
  )
}
