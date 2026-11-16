/**
 * @fileoverview An older version of the page's document, read-only (`…/documents/<docId>/v/<n>`, chosen in the
 * toolbar's version picker): a banner ("Viewing v2 of 4", Back to latest and, for an editor, Restore), its title and
 * its text on the read-only canvas (stored ids as names, `[FR:<id>]` citations linked, as a viewer reads it), with its
 * own Contents when the page shows them. The text is the History list's (the same query as the picker and the History
 * dialog). Restore is History's: a NEW version carrying this one's content (asked first), selected once it lands;
 * nothing is rewritten. The page keeps its own canvas (and any unsaved draft) mounted, out of sight, meanwhile.
 *
 * @module components/DocumentCanvas/page/OlderVersion
 */
import clsx from 'clsx'
import { History, Loader2, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../ConfirmModal/ConfirmModal'
import { useLabelKnownIds } from '../../../hooks/useLabelKnownIds'
import { linkFeatureRequestCitations } from '../../../pages/ProjectDetail/featureRequestCitations'
import { useVersionRestore } from '../../../pages/ProjectDetail/useVersionRestore'
import { READING_COLUMN_CLASS, READING_TEXT_CLASS } from '../comments/readingColumn'
import CanvasEditor from '../editor/CanvasEditor'
import Outline from './Outline'
import { TITLE_TEXT_CLASS } from './pageStyles'
import type { CanvasEditorHandle, OutlineItem } from '../editor/CanvasEditor'
import type { DocumentVersion } from '../../../api/projectDetailSchema'
import type { ProjectDocument } from '../../../api/types'

/** The older version asked for: its number and, once the History list has it, the version (null: not yet). */
export interface ViewedVersion {
  readonly number: number
  readonly version: DocumentVersion | null
  /** The latest version's number, once known. */
  readonly latest: number | null
  readonly loadFailed: boolean
}

interface OlderVersionProps {
  readonly projectId: string
  /** The page's document (a restore goes through it). */
  readonly document: ProjectDocument
  readonly viewed: ViewedVersion
  readonly canRestore: boolean
  readonly showOutline: boolean
  readonly onBack: () => void
  /** The restored version, a new one: the page moves to it. */
  readonly onRestored: (document: ProjectDocument) => void
}

function VersionBanner({ viewed, canRestore, restoring, onBack, onRestore }: Readonly<{
  viewed: ViewedVersion; canRestore: boolean; restoring: boolean; onBack: () => void; onRestore: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const label = t('documents.versions.label', { n: viewed.number })
  const text = viewed.latest === null
    ? t('canvas.versions.viewingOne', { version: label })
    : t('canvas.versions.viewing', { version: label, latest: viewed.latest })
  return (
    <section aria-label={t('canvas.versions.bannerLabel')} data-testid="older-version-banner"
      className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-info/30 bg-info-subtle p-3 text-sm text-text">
      <History size={14} className="text-info" aria-hidden="true" />
      <p className="mr-auto min-w-0 break-words">
        <span className="font-medium">{text}</span> · {t('canvas.versions.readOnly')}
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>{t('canvas.versions.backToLatest')}</button>
      {canRestore && viewed.version !== null ? (
        <button type="button" className="btn btn-secondary btn-sm" disabled={restoring} onClick={onRestore}
          aria-label={t('documents.versions.restoreNamed', { label })}>
          {restoring ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
          {t('documents.versions.restore')}
        </button>
      ) : null}
    </section>
  )
}

/** The version's text on the read-only canvas, with its Contents. */
function VersionText({ version, title, showOutline }: Readonly<{ version: DocumentVersion; title: string; showOutline: boolean }>) {
  const labelIds = useLabelKnownIds()
  const handle = useRef<CanvasEditorHandle | null>(null)
  const [outline, setOutline] = useState<readonly OutlineItem[]>([])
  return (
    <div className={clsx(outline.length > 0 && showOutline && 'lg:grid lg:grid-cols-[10rem_minmax(0,1fr)] lg:gap-6')}>
      {showOutline ? (
        <Outline items={outline} onNavigate={(id) => handle.current?.scrollToHeading(id)} className="mb-4 lg:mb-0" />
      ) : null}
      <article className={READING_COLUMN_CLASS} data-reading-column="">
        <CanvasEditor markdown={linkFeatureRequestCitations(labelIds(version.content))} editable={false} ariaLabel={title}
          onOutlineChange={setOutline} handleRef={handle} className={READING_TEXT_CLASS} />
      </article>
    </div>
  )
}

/** The version's text on its way, or why it could not be read. */
function VersionPending({ failed }: Readonly<{ failed: boolean }>) {
  const { t } = useTranslation('projectDetail')
  if (failed) return <p role="alert" className="text-[12px] text-danger">{t('documents.versions.loadFailed')}</p>
  return <div className="skeleton h-40" role="status" aria-label={t('canvas.toolbar.versionsLoading')} />
}

export default function OlderVersion({ projectId, document, viewed, canRestore, showOutline, onBack, onRestored }: OlderVersionProps) {
  const { t } = useTranslation('projectDetail')
  const restore = useVersionRestore(projectId, document.document_id, onRestored)
  const [confirming, setConfirming] = useState(false)
  const { version } = viewed
  const title = version?.title === undefined || version.title === '' ? document.title : version.title
  return (
    <div data-testid="older-version">
      <VersionBanner viewed={viewed} canRestore={canRestore} restoring={restore.isPending} onBack={onBack}
        onRestore={() => { restore.reset(); setConfirming(true) }} />
      {restore.isError ? <p role="alert" className="mb-3 text-[12px] text-danger">{t('documents.versions.restoreFailed')}</p> : null}
      <h2 className={clsx(TITLE_TEXT_CLASS, 'mb-6')}>{title}</h2>
      {version === null ? <VersionPending failed={viewed.loadFailed} /> : <VersionText version={version} title={title} showOutline={showOutline} />}
      <ConfirmModal
        isOpen={confirming}
        title={t('documents.versions.restoreTitle')}
        message={t('documents.versions.restoreMessage', { n: viewed.number })}
        confirmLabel={t('documents.versions.restore')}
        cancelLabel={t('documents.versions.cancel')}
        variant="info"
        onConfirm={() => {
          if (version !== null) restore.mutate(version.version_id)
          setConfirming(false)
        }}
        onCancel={() => setConfirming(false)}
      />
    </div>
  )
}
