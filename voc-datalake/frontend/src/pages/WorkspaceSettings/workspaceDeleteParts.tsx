/**
 * @fileoverview What the delete card and its confirmation both say (docs/multi-workspace.md → Export and delete): what
 * a workspace's delete removes (all of it; the members' access and every member's own assistant conversations and
 * personal memories called out), that the export holds none of those conversations or memories, and the way to the
 * export card above, to keep a copy first.
 *
 * @module pages/WorkspaceSettings/workspaceDeleteParts
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import Notice from '../../components/Notice/Notice'

/** The list of what is deleted, and the warning that the export does not hold the members' conversations. */
export function DeletedContents() {
  const { t } = useTranslation()
  const titleId = useId()
  // The two a member loses who never saw the delete coming are set apart from the rest.
  const items: readonly (readonly [string, boolean])[] = [
    [t('workspaces.delete.items.feedback'), false],
    [t('workspaces.delete.items.projects'), false],
    [t('workspaces.delete.items.agents'), false],
    [t('workspaces.delete.items.settings'), false],
    [t('workspaces.delete.items.files'), false],
    [t('workspaces.delete.items.members'), true],
    [t('workspaces.delete.items.conversations'), true],
    [t('workspaces.delete.items.companyMemory'), false],
  ]
  return (
    <div className="space-y-3">
      <div>
        <p id={titleId} className="text-sm font-medium text-text-strong">{t('workspaces.delete.itemsTitle')}</p>
        <ul aria-labelledby={titleId} className="mt-1 list-disc space-y-1 pl-5 text-sm text-text">
          {items.map(([text, strong]) => <li key={text} className={strong ? 'font-semibold text-text-strong' : undefined}>{text}</li>)}
        </ul>
      </div>
      <Notice variant="banner" tone="warn" role="note" icon={AlertTriangle} text={t('workspaces.delete.notInExport')} />
    </div>
  )
}

/** "Export it first", with the way to the export card. */
export function ExportFirst({ onShowExport }: Readonly<{ onShowExport: () => void }>) {
  const { t } = useTranslation()
  return (
    <p className="text-sm text-muted">
      {t('workspaces.delete.exportFirst')}{' '}
      <button type="button" className="link" onClick={onShowExport}>{t('workspaces.delete.exportLink')}</button>
    </p>
  )
}
