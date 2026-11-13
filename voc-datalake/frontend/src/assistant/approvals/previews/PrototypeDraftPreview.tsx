/**
 * @fileoverview Preview for `draft_prototype_revision` (docs/prototype-builder.md, part 2): the prototype the
 * draft revises (its title and version, from the project record) and the EXACT instruction the draft job
 * will get, as text; then that the draft is only a preview until it is applied on the prototype's page.
 *
 * @module assistant/approvals/previews/PrototypeDraftPreview
 */
import { useTranslation } from 'react-i18next'
import { useProjectDetail } from './useProjectDetail'
import type { DraftPrototypeRevisionArgs } from '../prototypeSchemas'

export function PrototypeDraftPreview({ args }: Readonly<{ args: DraftPrototypeRevisionArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data } = useProjectDetail(args.project_id)
  const prototype = data?.documents.find((d) => d.document_id === args.document_id)
  return (
    <div className="space-y-2 text-[13px]">
      <p>
        <span className="font-medium">{t('preview.prototypeDraft.prototype')}</span>{' '}
        {/* The title carries its version, "Checkout (v3)"; the id until the project record is read. */}
        {prototype?.title ?? args.document_id}
      </p>
      <div>
        <p className="font-medium">{t('preview.prototypeDraft.instruction')}</p>
        {/* Verbatim and as text: what the draft job gets, never rendered as Markdown or HTML. */}
        <p data-testid="prototype-draft-instruction" className="whitespace-pre-wrap break-words rounded-md border bg-bg-accent p-2">
          {args.instruction}
        </p>
      </div>
      <p className="rounded-md border border-info/30 bg-info-subtle p-2 text-[12px] text-info">{t('preview.prototypeDraft.note')}</p>
    </div>
  )
}
