/**
 * @fileoverview A repository's **Tenets review** (§6.4 [52] step 2; the setup guide's Tenets step): the drafts the
 * Tenets flow wrote (`GET …/tenets/<connection>`), one version at a time, on the shared document component.
 *
 * - A version reads as its Markdown projection (documents/tenetsDocument.ts, the `model` policy: an agent wrote it),
 *   with what it changes from the version it was drafted on, else the accepted one, keyed by tenet id: added,
 *   changed (which fields), removed.
 * - A draft is **accepted** (the one primary) or **rejected** with an optional reason, never edited (D6-3: run Tenets
 *   again for another draft). A decision names the accepted version the screen showed (`expected_accepted`, gap P):
 *   a 409 says the accepted tenets moved meanwhile and offers **Read it again**.
 * - Once a version is accepted, **Open as a pull request** shows the server's `TENETS.md` and publishes it
 *   (DocsPublishSheet.tsx).
 *
 * @module pages/Agents/Knowledge/TenetsReview
 */
import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitPullRequest, Loader2 } from 'lucide-react'
import DocumentSurface from '../../../components/Document/DocumentSurface'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'
import { engineeringKnowledgeApi, engineeringKnowledgeKeys } from '../../../api/engineeringKnowledgeApi'
import { serverReason } from '../../../lib/errors'
import { useConfigStore } from '../../../store/configStore'
import { useSkillFormats } from '../skillFormats'
import { DocsPublishSheet } from './DocsPublishSheet'
import { TenetsChanges } from './TenetsChanges'
import { neverSaved } from '../documents/readOnly'
import {
  MAX_TENETS_REASON, comparedWith, isTenetsStale, tenetsAdapter, tenetsChanges, tenetsDecisionBody, tenetsDocumentOf,
  tenetsToReview,
} from '../documents/tenetsDocument'
import type { TenetsDecision, TenetsHead, TenetsVersion } from '../../../api/engineeringKnowledgeApi'
import type { TenetChange, TenetsLabels } from '../documents/tenetsDocument'

function useLabels(): TenetsLabels {
  const { t } = useTranslation('agents')
  return { summary: t('tenets.projection.summary'), why: t('tenets.projection.why'), cites: t('tenets.projection.cites') }
}

function useTenetsVersion(connection: string, version: number | null) {
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  return useQuery({
    queryKey: engineeringKnowledgeKeys.tenetsVersion(connection, version ?? 0),
    queryFn: () => engineeringKnowledgeApi.tenetsVersion(connection, version ?? 0),
    enabled: configured && version !== null,
  })
}

/** Accept or reject a draft with a reason, from the accepted version the screen showed; a 409: read it again. */
function Decision({ connection, version, head, onReadAgain }: Readonly<{
  connection: string; version: TenetsVersion; head: TenetsHead; onReadAgain: () => Promise<unknown>
}>) {
  const { t } = useTranslation('agents')
  const reasonId = useId()
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [reading, setReading] = useState(false)
  const decide = useMutation({
    mutationFn: (decision: TenetsDecision) =>
      engineeringKnowledgeApi.decideTenets(connection, version.version, decision, tenetsDecisionBody(head, reason)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: engineeringKnowledgeKeys.connection(connection) }),
  })
  const readAgain = async () => {
    setReading(true)
    try {
      await onReadAgain()
      decide.reset()
    } finally {
      setReading(false)
    }
  }
  const stale = decide.isError && isTenetsStale(decide.error)
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <label htmlFor={reasonId} className="block text-[12px] font-semibold text-muted">{t('tenets.reason')}</label>
      <textarea id={reasonId} className="input w-full" rows={2} maxLength={MAX_TENETS_REASON} value={reason}
        onChange={(event) => setReason(event.target.value)} />
      <StickyActionBar variant="inline" className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" className="btn btn-secondary btn-sm" aria-disabled={decide.isPending}
          onClick={() => { if (!decide.isPending) decide.mutate('reject') }}>{t('tenets.reject')}</button>
        <button type="button" className="btn btn-primary btn-sm" aria-disabled={decide.isPending}
          onClick={() => { if (!decide.isPending) decide.mutate('accept') }}>
          {decide.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {t('tenets.accept', { version: version.version })}
        </button>
      </StickyActionBar>
      {stale && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
          <p className="mr-auto min-w-0">{t('tenets.stale')}</p>
          <button type="button" className="btn btn-secondary btn-sm" disabled={reading} onClick={() => void readAgain()}>
            {reading && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('tenets.readAgain')}
          </button>
        </div>
      )}
      {decide.isError && !stale && (
        <p role="alert" className="text-sm text-danger">
          {serverReason(decide.error) === null ? t('tenets.decideFailed') : t('tenets.refused', { message: serverReason(decide.error) })}
        </p>
      )}
    </div>
  )
}

/** Its status, who wrote it and when, and who decided it. */
function VersionLine({ version }: Readonly<{ version: TenetsVersion }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
      <span className={version.status === 'accepted' ? 'badge badge-ok' : 'badge badge-muted'}>
        {t(`tenets.status.${version.status}`, { defaultValue: version.status })}
      </span>
      {version.author_kind === 'agent' && <span className="badge badge-aim">{t('tenets.byAgent')}</span>}
      <span>{t('tenets.drafted', { at: format.at(version.created_at) })}</span>
      {version.decided_by !== null && version.decided_at !== null && (
        <span>{t('tenets.decided', { who: version.decided_by, at: format.at(version.decided_at) })}</span>
      )}
    </p>
  )
}

/** What a version changes from the one it is compared with (none: everything is new); null while that one is read. */
function changesOf(version: TenetsVersion, other: number | null, before: TenetsVersion | undefined): TenetChange[] | null {
  if (other === null) return tenetsChanges(null, version.record)
  return before === undefined ? null : tenetsChanges(before.record, version.record)
}

function VersionView({ connection, number, head, onReadAgain }: Readonly<{
  connection: string; number: number; head: TenetsHead; onReadAgain: () => Promise<unknown>
}>) {
  const { t } = useTranslation('agents')
  const labels = useLabels()
  const read = useTenetsVersion(connection, number)
  const version = read.data?.version
  const other = version === undefined ? null : comparedWith(version, head)
  const before = useTenetsVersion(connection, other)
  if (read.isError) return <LoadFailed message={t('tenets.versionFailed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
  if (version === undefined) return <TenetsSurface connection={connection} number={number} version={null} labels={labels} />
  const changes = changesOf(version, other, before.data?.version)
  return (
    <div className="space-y-3">
      <VersionLine version={version} />
      {other !== null && <p className="text-[12px] text-muted">{t('tenets.comparedWith', { version: other })}</p>}
      {changes !== null && <TenetsChanges changes={changes} first={other === null} />}
      <TenetsSurface connection={connection} number={number} version={version} labels={labels} />
      {version.status === 'draft' && <Decision connection={connection} version={version} head={head} onReadAgain={onReadAgain} />}
    </div>
  )
}

/** The version's projection on the surface (loading lines until it is read). */
function TenetsSurface({ connection, number, version, labels }: Readonly<{
  connection: string; number: number; version: TenetsVersion | null; labels: TenetsLabels
}>) {
  const { t } = useTranslation('agents')
  const title = (n: number) => t('tenets.title', { version: n })
  return (
    <DocumentSurface adapter={tenetsAdapter(connection, version?.status ?? 'draft', title, labels)} variant="inline"
      title={title(number)} headingLevel={3} meta={null}
      stored={version === null ? undefined : tenetsDocumentOf(connection, version, title(version.version), labels)} mode="read"
      compare={null} comments={null} onSaved={neverSaved} fullPath={null} footer={null} onClose={null} page={null}>
      {null}
    </DocumentSurface>
  )
}

export function TenetsReview({ connection }: Readonly<{ connection: string }>) {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const queryClient = useQueryClient()
  const selectId = useId()
  const [chosen, setChosen] = useState<number | null>(null)
  const [publishing, setPublishing] = useState(false)
  const read = useQuery({
    queryKey: engineeringKnowledgeKeys.tenets(connection), queryFn: () => engineeringKnowledgeApi.tenets(connection), enabled: configured,
  })
  if (read.isLoading) return <div className="skeleton h-24" role="status" aria-label={t('tenets.loading')} />
  if (read.isError || read.data === undefined) {
    return <LoadFailed message={t('tenets.failed')} onRetry={() => void read.refetch()} retrying={read.isFetching} />
  }
  const { head, versions } = read.data
  if (versions.length === 0) return <p className="rounded-md border border-border p-3 text-sm text-muted">{t('tenets.none')}</p>
  const shown = chosen ?? tenetsToReview(versions, head) ?? versions[0]?.version ?? 1
  const readAgain = () => queryClient.invalidateQueries({ queryKey: engineeringKnowledgeKeys.connection(connection) })
  return (
    <section aria-label={t('tenets.label')} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={selectId} className="block text-[12px] font-semibold text-muted">{t('tenets.version')}</label>
          <select id={selectId} className="select w-auto" value={shown} onChange={(event) => setChosen(Number(event.target.value))}>
            {versions.map((version) => (
              <option key={version.version} value={version.version}>
                {t('tenets.versionOption', { version: version.version, status: t(`tenets.status.${version.status}`, { defaultValue: version.status }) })}
              </option>
            ))}
          </select>
        </div>
        {head.accepted_version !== null && (
          <button type="button" className="btn btn-secondary btn-sm ms-auto" onClick={() => setPublishing(true)}>
            <GitPullRequest size={14} aria-hidden="true" />{t('tenets.publish')}
          </button>
        )}
      </div>
      <p className="text-[12px] text-muted">
        {head.accepted_version === null ? t('tenets.noneAccepted') : t('tenets.accepted', { version: head.accepted_version })}
      </p>
      <VersionView key={shown} connection={connection} number={shown} head={head} onReadAgain={readAgain} />
      {publishing && <DocsPublishSheet connection={connection} kind="tenets" onClose={() => setPublishing(false)} />}
    </section>
  )
}
