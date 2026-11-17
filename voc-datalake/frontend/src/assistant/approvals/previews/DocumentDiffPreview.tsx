/**
 * @fileoverview `update_document` preview: a line diff of the stored document
 * against the proposed content, collapsed to the changed regions (the shared
 * document component's TextDiff). Inputs past the diff caps fall back to a
 * side-by-side excerpt.
 *
 * @module assistant/approvals/previews/DocumentDiffPreview
 */
import { useTranslation } from 'react-i18next'
import TextDiff from '../../../components/Document/diff/TextDiff'
import { LongText } from './ValueView'
import { useProjectDetail } from './useProjectDetail'
import type { UpdateDocumentArgs } from '../schemas'

export function DocumentDiffPreview({ args }: Readonly<{ args: UpdateDocumentArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data, isLoading, isError } = useProjectDetail(args.project_id)
  const doc = data?.documents.find((d) => d.document_id === args.document_id)

  const body = (() => {
    if (isLoading) return <p className="text-[12px] text-muted">{t('preview.loading')}</p>
    if (isError || doc === undefined) {
      return (
        <div>
          <p className="text-[12px] text-warn mb-1">{t('preview.diff.currentUnavailable')}</p>
          <LongText text={args.content} />
        </div>
      )
    }
    return (
      <TextDiff before={doc.content} after={args.content} identicalText={t('preview.diff.noChanges')}
        beforeLabel={t('preview.before')} afterLabel={t('preview.after')} />
    )
  })()

  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="text-[12px] font-medium text-muted">{t('preview.document')}: </span>
        {doc?.title ?? args.document_id}
        {args.title !== undefined && args.title !== doc?.title && (
          <span> → <strong>{args.title}</strong></span>
        )}
      </p>
      {args.change_summary !== '' && (
        <p>
          <span className="text-[12px] font-medium text-muted">{t('preview.changeSummary')}: </span>
          {args.change_summary}
        </p>
      )}
      {body}
    </div>
  )
}
