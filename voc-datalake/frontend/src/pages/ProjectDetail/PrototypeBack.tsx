/**
 * Back to vN on a prototype (docs/prototype-builder.md, part 2): one click writes a NEW version
 * of the series from an earlier version's HTML, through the existing restore route. Nothing is
 * deleted; the restored version gets its own pin form on the server.
 *
 * On the newest version it offers the version before it ("Back to v3"); on an older version it
 * offers that version itself ("Restore v2"), so a person looking at an old version can bring it
 * back without first finding the newest.
 *
 * @module pages/ProjectDetail/PrototypeBack
 */
import { Loader2, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectDocument } from '../../api/types'
import { refusalReason } from '../../lib/errors'
import { backTarget } from './documentEdit'
import { useVersionRestore } from './useVersionRestore'

export default function PrototypeBackButton({ projectId, document, documents, onSelectDoc }: Readonly<{
  projectId: string
  document: ProjectDocument
  documents: readonly ProjectDocument[]
  onSelectDoc: (doc: ProjectDocument) => void
}>) {
  const { t } = useTranslation('projectDetail')
  const restore = useVersionRestore(projectId, document.document_id, onSelectDoc)
  const choice = backTarget(document, documents)
  if (choice === null) return null
  const n = choice.target.version ?? 0
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" className="btn btn-secondary btn-sm" disabled={restore.isPending}
        title={t('documents.prototype.backHint', { n })}
        onClick={() => { restore.mutate(choice.target.document_id) }}>
        {restore.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RotateCcw size={14} aria-hidden />}
        {choice.kind === 'back' ? t('documents.prototype.backTo', { n }) : t('documents.prototype.restoreThis', { n })}
      </button>
      {/* A refusal the server explains is shown in its words (trying again cannot help); anything else keeps "try again". */}
      {restore.isError
        ? <span role="alert" className="text-[12px] text-danger">{refusalReason(restore.error) ?? t('documents.versions.restoreFailed')}</span>
        : null}
    </span>
  )
}
