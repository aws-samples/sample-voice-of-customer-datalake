/**
 * @fileoverview **Open as a pull request**: the docs an administrator approved (the knowledge pack's `docs/agents/**`
 * or the tenets' `TENETS.md`), previewed file by file and published (§6.4 [52] steps 2 and 3), on the app's side sheet.
 *
 * - The preview (`GET …/docs/<connection>/preview?kind=`) lists every file the approval renders to now; each opens as
 *   a document of its own, from its text (gap O, documents/docsPreviewDocument.ts). A file past the preview's bound
 *   says it is in the patch. When the stored records no longer render to what was approved, it says a publish will
 *   be refused.
 * - **Open the pull request** (`POST …/publish {kind, digest}`) writes `voc-agent/docs-<kind>-v<n>` (one level under
 *   `voc-agent/` since 7.71.04; the preview's `branch`) and opens it ready for review (or as a draft, as the flow
 *   says). Only a person merges it, on the host.
 * - Refused: a Human-driven administrator gets the patch to apply themselves (Copy, Download); a version published
 *   before says so; another rendering than the preview's offers to read it again; nothing approved says so.
 *
 * @module pages/Agents/Knowledge/DocsPublishSheet
 */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, FileText, Loader2 } from 'lucide-react'
import CodeView from '../../../components/Document/text/CodeView'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import SideSheet from '../../../components/SideSheet/SideSheet'
import { engineeringKnowledgeApi, engineeringKnowledgeKeys } from '../../../api/engineeringKnowledgeApi'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { useConfigStore } from '../../../store/configStore'
import { downloadFile } from '../../../utils/file'
import { patchFileName, previewFileAdapter, previewFileDocumentOf, publishOutcomeOf } from '../documents/docsPreviewDocument'
import ReadOnlySurface from '../documents/ReadOnlySurface'
import type { DocsKind, DocsPreview, DocsPublished } from '../../../api/engineeringKnowledgeApi'
import type { PublishOutcome } from '../documents/docsPreviewDocument'

function FileDocument({ connection, preview, path }: Readonly<{ connection: string; preview: DocsPreview; path: string }>) {
  const { t } = useTranslation('agents')
  const file = preview.files.find((entry) => entry.path === path)
  const stored = file === undefined ? null : previewFileDocumentOf(file)
  if (stored === null) return <p className="text-sm text-muted">{t('knowledge.publish.inPatch')}</p>
  return (
    <ReadOnlySurface adapter={previewFileAdapter(connection, preview.kind, path)} variant="inline" title={path} headingLevel={3}
      meta={null} stored={stored} mode="read" compare={null} fullPath={null} />
  )
}

function FileList({ preview, open, onOpen }: Readonly<{ preview: DocsPreview; open: string | null; onOpen: (path: string) => void }>) {
  const { t, i18n } = useTranslation('agents')
  const kb = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 })
  return (
    <section aria-labelledby="docs-files" className="space-y-2">
      <h3 id="docs-files" className="text-sm font-semibold text-text-strong">{t('knowledge.publish.files', { n: preview.files.length })}</h3>
      <ul className="space-y-1">
        {preview.files.map((file) => (
          <li key={file.path}>
            <button type="button" className="btn btn-ghost btn-sm max-w-full justify-start text-left" aria-pressed={open === file.path}
              onClick={() => onOpen(file.path)}>
              <FileText size={14} aria-hidden="true" />
              <span className="font-mono break-all">{file.path}</span>
              <span className="text-muted">{t('knowledge.publish.size', { kb: kb.format(file.bytes / 1024) })}</span>
            </button>
          </li>
        ))}
      </ul>
      {preview.texts_truncated && <p className="text-[12px] text-muted">{t('knowledge.publish.textsCut')}</p>}
    </section>
  )
}

/** A Human-driven administrator's way on: the patch to apply, with Copy (the code view's) and Download. */
function PatchToApply({ preview }: Readonly<{ preview: DocsPreview }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-secondary btn-sm"
        onClick={() => downloadFile(preview.patch, patchFileName(preview), 'text/x-diff')}>
        <Download size={14} aria-hidden="true" />{t('knowledge.publish.download')}
      </button>
      {preview.patch_truncated && <p className="text-[12px] text-warn">{t('knowledge.publish.patchCut')}</p>}
      <CodeView text={preview.patch} label={t('knowledge.publish.patchLabel')} />
    </div>
  )
}

function Opened({ published }: Readonly<{ published: DocsPublished }>) {
  const { t } = useTranslation('agents')
  const pr = published.pr
  return (
    <div role="status" className="space-y-1 rounded-lg border border-ok/30 bg-ok-subtle p-3 text-sm text-text">
      <p>{t(published.draft ? 'knowledge.publish.openedDraft' : 'knowledge.publish.opened', { number: pr?.number ?? 0 })}</p>
      <p className="text-[12px] text-muted">{t('knowledge.publish.personMerges')}</p>
      {pr !== null && pr.url !== '' && (
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="link inline-flex items-center gap-1">
          {t('knowledge.publish.openPr')}<ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
    </div>
  )
}

function OutcomeView({ outcome, preview, onReadAgain }: Readonly<{
  outcome: PublishOutcome; preview: DocsPreview; onReadAgain: () => void
}>) {
  const { t } = useTranslation('agents')
  if (outcome.kind === 'opened') return <Opened published={outcome.published} />
  if (outcome.kind === 'failed') {
    return <p role="alert" className="text-sm text-danger">{outcome.message ?? t('knowledge.publish.failed')}</p>
  }
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
      <p>{t(`knowledge.publish.refused.${outcome.code}`)}</p>
      {outcome.code === 'digest_mismatch' && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={onReadAgain}>{t('knowledge.publish.readAgain')}</button>
      )}
      {outcome.code === 'human_driven' && <PatchToApply preview={preview} />}
    </div>
  )
}

function useOutcome(connection: string, kind: DocsKind) {
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null)
  const publish = useMutation({
    mutationFn: (digest: string) => engineeringKnowledgeApi.publish(connection, kind, digest),
    onSuccess: (published) => setOutcome({ kind: 'opened', published }),
    onError: (error) => setOutcome(publishOutcomeOf(error)),
  })
  return { outcome, publish, clear: () => setOutcome(null) }
}

export function DocsPublishSheet({ connection, kind, onClose }: Readonly<{ connection: string; kind: DocsKind; onClose: () => void }>) {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const read = useQuery({
    queryKey: engineeringKnowledgeKeys.preview(connection, kind), queryFn: () => engineeringKnowledgeApi.preview(connection, kind),
    enabled: configured,
  })
  const { outcome, publish, clear } = useOutcome(connection, kind)
  const preview = read.data
  const offered = preview !== undefined && outcome?.kind !== 'opened'
  const readAgain = () => { clear(); void read.refetch() }
  const footer = (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>{t('knowledge.publish.close')}</button>
      {offered && (
        <button type="button" className="btn btn-primary btn-sm" aria-disabled={publish.isPending}
          onClick={() => { if (!publish.isPending) publish.mutate(preview.digest) }}>
          {publish.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('knowledge.publish.submit')}
        </button>
      )}
    </>
  )
  return (
    <SideSheet isOpen onClose={onClose} size="wide" title={t(`knowledge.publish.title.${kind}`)} footer={footer}
      description={preview === undefined ? undefined : t('knowledge.publish.branch', { branch: preview.branch, version: preview.version })}>
      <PreviewState read={read} />
      {preview !== undefined && <PreviewBody connection={connection} preview={preview} outcome={outcome} onReadAgain={readAgain} />}
    </SideSheet>
  )
}

/** The preview's body: its note when it no longer matches the approval, the outcome, the files and the open one. */
function PreviewBody({ connection, preview, outcome, onReadAgain }: Readonly<{
  connection: string; preview: DocsPreview; outcome: PublishOutcome | null; onReadAgain: () => void
}>) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState<string | null>(null)
  return (
    <>
      <p className="text-sm text-muted">{t('knowledge.publish.hint')}</p>
      {!preview.matches && (
        <p role="note" className="rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">{t('knowledge.publish.mismatch')}</p>
      )}
      {outcome !== null && <OutcomeView outcome={outcome} preview={preview} onReadAgain={onReadAgain} />}
      <FileList preview={preview} open={open} onOpen={setOpen} />
      {open !== null && <FileDocument key={open} connection={connection} preview={preview} path={open} />}
    </>
  )
}

interface PreviewRead {
  readonly isLoading: boolean
  readonly isError: boolean
  readonly isFetching: boolean
  readonly error: unknown
  readonly refetch: () => Promise<unknown>
}

/** Why the preview is not on screen: loading, nothing approved yet (404), or a failed read. */
function PreviewState({ read }: Readonly<{ read: PreviewRead }>) {
  const { t } = useTranslation('agents')
  if (read.isLoading) return <div className="skeleton h-24" role="status" aria-label={t('knowledge.publish.loading')} />
  if (!read.isError) return null
  if (apiErrorStatus(read.error) === 404) return <p className="text-sm text-muted">{t('knowledge.publish.refused.not_approved')}</p>
  return <LoadFailed message={t('knowledge.publish.previewFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
}
