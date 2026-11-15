/**
 * @fileoverview The frame of an approval card that writes to a prototype (a draft revision, a walkthrough): the
 * prototype's title, which carries its version ("Checkout (v3)"), from the project record (its id until that record
 * is read); then what the card does; then its note.
 * @module assistant/approvals/previews/PrototypeLine
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectDetail } from './useProjectDetail'

interface PrototypePreviewProps {
  readonly projectId: string
  readonly documentId: string
  /** The translated note under the card's body (what saving or drafting does). */
  readonly note: string
  readonly children: ReactNode
}

export function PrototypePreview({ projectId, documentId, note, children }: PrototypePreviewProps) {
  const { t } = useTranslation('assistantTools')
  const { data } = useProjectDetail(projectId)
  const prototype = data?.documents.find((d) => d.document_id === documentId)
  return (
    <div className="space-y-2 text-[13px]">
      <p>
        <span className="font-medium">{t('preview.prototypeDraft.prototype')}</span>{' '}
        {prototype?.title ?? documentId}
      </p>
      {children}
      <p className="rounded-md border border-info/30 bg-info-subtle p-2 text-[12px] text-info">{note}</p>
    </div>
  )
}
