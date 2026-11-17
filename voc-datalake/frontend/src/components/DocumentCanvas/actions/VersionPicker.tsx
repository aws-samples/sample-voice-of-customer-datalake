/**
 * @fileoverview The toolbar's version picker: a menu button showing the version on screen ("v4"), its menu every
 * version of the document, newest first (v4 … v1; up to the History list's 25), the latest marked "Latest" and the one
 * on screen checked. The versions are the History dialog's (`GET …/documents/{doc}/versions`, one query), read when the
 * menu opens: a PRD / PR/FAQ's series versions, another document's saved revisions.
 *
 * Choosing one says what it is to the page (versionChoices.ts `VersionChoice`): its own version (back to it), the
 * latest of a series the page shows an older row of (the page moves to it), or an older version, which the page shows
 * read-only under its banner at `…/v/<n>` (OlderVersion). Nothing is written. Opened before the versions came, the
 * menu gives its first one the focus as they arrive.
 *
 * @module components/DocumentCanvas/actions/VersionPicker
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../../api/projectsApi'
import { documentRevision, documentVersionsKey } from '../../../pages/ProjectDetail/documentEdit'
import { useMenuButton } from '../../ProfileMenu/useMenuButton'
import { formatDateTime } from '../../../utils/dateUtils'
import { ToolbarMenu } from './toolbarControls'
import { choiceOf, ownVersion } from './versionChoices'
import type { CanvasMenuEntry } from './CanvasMenu'
import type { RovingItem } from './useRovingToolbar'
import type { VersionChoice } from './versionChoices'
import type { ProjectDocument } from '../../../api/types'

interface VersionPickerProps {
  readonly projectId: string
  /** The page's document. */
  readonly document: ProjectDocument
  /** The number of the older version on screen; null: the page's own. */
  readonly viewing: number | null
  readonly rove: RovingItem
  readonly onChoose: (choice: VersionChoice) => void
}

export default function VersionPicker({ projectId, document, viewing, rove, onChoose }: VersionPickerProps) {
  const { t, i18n } = useTranslation('projectDetail')
  const menu = useMenuButton()
  const versions = useQuery({
    queryKey: documentVersionsKey(projectId, document.document_id),
    queryFn: () => projectsApi.getDocumentVersions(projectId, document.document_id),
    enabled: menu.open,
  })
  // Opened before the versions came (the first time): they take the focus as they arrive, as a menu's items do.
  const { open, buttonRef, menuRef } = menu
  const loaded = versions.data !== undefined
  useEffect(() => {
    if (!open || !loaded || globalThis.document.activeElement !== buttonRef.current) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus()
  }, [buttonRef, loaded, menuRef, open])
  const shown =t('documents.versions.label', { n: viewing ?? documentRevision(document) ?? 1 })
  const notice = (() => {
    if (versions.isError) return t('documents.versions.loadFailed')
    return versions.data === undefined ? t('documents:toolbar.versionsLoading') : null
  })()
  const entries = (): CanvasMenuEntry[] => {
    const list = versions.data ?? []
    const own = ownVersion(list, document)?.version_id
    return list.map((version) => ({
      kind: 'radio', id: version.version_id, label: t('documents.versions.label', { n: version.version }),
      checked: viewing === null ? version.version_id === own : version.version === viewing,
      detail: formatDateTime(version.created_at, i18n.language),
      badge: version.current ? t('documents:toolbar.latest') : null,
      onSelect: () => onChoose(choiceOf(version, list, document)),
    }))
  }
  return (
    <ToolbarMenu menu={menu} rove={rove} wide label={t('documents:toolbar.version', { version: shown })}
      hint={t('documents:toolbar.versionHint')} notice={notice} entries={entries}
      face={(
        <>
          <span className="font-mono">{shown}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </>
      )} />
  )
}
