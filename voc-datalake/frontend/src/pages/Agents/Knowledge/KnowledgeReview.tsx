/**
 * @fileoverview A repository's **Knowledge review** (§6.4 [52] step 3; the setup guide's Understand step): each
 * package's pack versions (`GET …/knowledge/<connection>`), the seven documents of one version at a time on the shared
 * document component (a `tabs-track` switcher on wide screens, a select on narrow ones; Contents on a long one), each
 * **compared with the approved version**, then **Approve** (the one primary; `POST …/approve`). There is no reject:
 * a version not approved stays. A 409 says the version or the approved one moved meanwhile: **Read it again**.
 * Once something is approved, **Open as a pull request** previews the `docs/agents/**` files and publishes them
 * (DocsPublishSheet.tsx).
 *
 * @module pages/Agents/Knowledge/KnowledgeReview
 */
import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { GitPullRequest, Loader2 } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import ReadPending from '../../../components/LoadFailed/ReadPending'
import PressedChoices from '../../../components/PressedChoices/PressedChoices'
import { KNOWLEDGE_KINDS, engineeringKnowledgeApi, engineeringKnowledgeKeys } from '../../../api/engineeringKnowledgeApi'
import { serverReason } from '../../../lib/errors'
import { useSkillFormats } from '../skillFormats'
import { DocsPublishSheet } from './DocsPublishSheet'
import { useKnowledgeRead } from './knowledgeReads'
import { approvable, isKnowledgeStale, knowledgeAdapter, knowledgeDocumentOf, versionsNewestFirst, versionToReview } from '../documents/knowledgeDocument'
import ReadOnlySurface from '../documents/ReadOnlySurface'
import type { KnowledgeKind, KnowledgePackage, KnowledgeVersion, PackVersion } from '../../../api/engineeringKnowledgeApi'
import type { SurfaceCompare } from '../../../components/Document/DocumentSurface'

type View = 'read' | 'compare'
const VIEWS: readonly View[] = ['read', 'compare']

const usePackVersion = (connection: string, segment: string, version: number | null) => useKnowledgeRead(
  engineeringKnowledgeKeys.packVersion(connection, segment, version ?? 0),
  () => engineeringKnowledgeApi.packVersion(connection, segment, version ?? 0), version !== null)

/** The seven documents' switcher: segments from `sm`, a select below it (the same choice). */
function KindSwitcher({ kind, onChange }: Readonly<{ kind: KnowledgeKind; onChange: (kind: KnowledgeKind) => void }>) {
  const { t } = useTranslation('agents')
  const id = useId()
  return (
    <>
      <PressedChoices label={t('knowledge.kinds.label')} choices={KNOWLEDGE_KINDS} value={kind} onChange={onChange}
        display={(choice) => t(`knowledge.kinds.${choice}`)} className="tabs-track hidden w-fit flex-wrap sm:flex"
        pressedClassName="tab tab-active" idleClassName="tab" />
      <div className="sm:hidden">
        <label htmlFor={id} className="block text-[12px] font-semibold text-muted">{t('knowledge.kinds.label')}</label>
        <select id={id} className="select w-full" value={kind}
          onChange={(event) => onChange(KNOWLEDGE_KINDS.find((each) => each === event.target.value) ?? kind)}>
          {KNOWLEDGE_KINDS.map((each) => <option key={each} value={each}>{t(`knowledge.kinds.${each}`)}</option>)}
        </select>
      </div>
    </>
  )
}

/** The compare's other side: the approved version's document of this kind, once read (null: none to compare). */
function compareWithApproved(approved: KnowledgeVersion | undefined, approvedVersion: number | null, version: PackVersion,
  kind: KnowledgeKind, identicalText: string): SurfaceCompare | null {
  if (approvedVersion === null || approved === undefined) return null
  return { before: approved.documents[kind] ?? '', beforeLabel: `v${String(approvedVersion)}`, afterLabel: `v${String(version.version)}`,
    identicalText }
}

/** One document of the version: read, or compared with the approved version's. */
function KindDocument({ connection, pkg, version, kind, view }: Readonly<{
  connection: string; pkg: KnowledgePackage; version: PackVersion; kind: KnowledgeKind; view: View
}>) {
  const { t } = useTranslation('agents')
  const read = usePackVersion(connection, pkg.segment, version.version)
  const approvedVersion = view === 'compare' && pkg.approved_version !== version.version ? pkg.approved_version : null
  const approved = usePackVersion(connection, pkg.segment, approvedVersion)
  const failed = [read, approved].find((query) => query.isError) ?? null
  if (failed !== null) {
    return <LoadFailed message={t('knowledge.versionFailed')} onRetry={() => void failed.refetch()} retrying={failed.isFetching} />
  }
  const title = t(`knowledge.kinds.${kind}`)
  const stored = read.data && knowledgeDocumentOf(connection, pkg.segment, read.data, kind, title)
  if (stored === null) return <p className="text-sm text-muted">{t('knowledge.kindMissing')}</p>
  const compare = compareWithApproved(approved.data, approvedVersion, version, kind, t('knowledge.identical'))
  return (
    <ReadOnlySurface adapter={knowledgeAdapter(connection, pkg.segment, kind, version.status, title)} variant="inline" title={title}
      headingLevel={3} meta={null} stored={approvedVersion !== null && compare === null ? undefined : stored}
      mode={compare === null ? 'read' : 'compare'} compare={compare} fullPath={null} />
  )
}

function Approve({ connection, pkg, version }: Readonly<{ connection: string; pkg: KnowledgePackage; version: PackVersion }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const approve = useMutation({
    mutationFn: () => engineeringKnowledgeApi.approve(connection, pkg.segment, version.version),
    onSettled: () => queryClient.invalidateQueries({ queryKey: engineeringKnowledgeKeys.connection(connection) }),
  })
  const stale = approve.isError && isKnowledgeStale(approve.error)
  if (approve.isSuccess) return <p role="status" className="text-sm text-ok">{t('knowledge.approved', { version: version.version })}</p>
  return (
    <div className="space-y-2">
      <button type="button" className="btn btn-primary btn-sm" aria-disabled={approve.isPending}
        onClick={() => { if (!approve.isPending) approve.mutate() }}>
        {approve.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('knowledge.approve', { version: version.version })}
      </button>
      {stale && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
          <p className="mr-auto min-w-0">{t('knowledge.stale')}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => approve.reset()}>{t('knowledge.readAgain')}</button>
        </div>
      )}
      {approve.isError && !stale && (
        <p role="alert" className="text-sm text-danger">
          {serverReason(approve.error) === null ? t('knowledge.approveFailed') : t('knowledge.refused', { message: serverReason(approve.error) })}
        </p>
      )}
    </div>
  )
}

function VersionLine({ version, approvedVersion }: Readonly<{ version: PackVersion; approvedVersion: number | null }>) {
  const { t } = useTranslation('agents')
  const format = useSkillFormats()
  return (
    <p className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
      <span className={version.status === 'approved' ? 'badge badge-ok' : 'badge badge-muted'}>
        {t(`knowledge.status.${version.status}`, { defaultValue: version.status })}
      </span>
      {version.version === approvedVersion && <span className="badge badge-accent">{t('knowledge.inUse')}</span>}
      {version.author_kind === 'agent' && <span className="badge badge-aim">{t('knowledge.byAgent')}</span>}
      <span>{t('knowledge.written', { at: format.at(version.created_at) })}</span>
      {version.built_from !== '' && <span className="font-mono">{t('knowledge.builtFrom', { commit: version.built_from.slice(0, 12) })}</span>}
    </p>
  )
}

function PackageReview({ connection, pkg }: Readonly<{ connection: string; pkg: KnowledgePackage }>) {
  const { t } = useTranslation('agents')
  const selectId = useId()
  const versions = versionsNewestFirst(pkg)
  const [chosen, setChosen] = useState<number | null>(null)
  const [kind, setKind] = useState<KnowledgeKind>('architecture')
  const [view, setView] = useState<View>('compare')
  const number = chosen ?? versionToReview(pkg)
  const version = versions.find((each) => each.version === number)
  const comparable = version !== undefined && pkg.approved_version !== null && pkg.approved_version !== version.version
  if (version === undefined) return null
  return (
    <section aria-labelledby={`${selectId}-title`} className="card space-y-3 p-4">
      <h3 id={`${selectId}-title`} className="text-sm font-semibold text-text-strong">
        {pkg.package === '.' ? t('knowledge.rootPackage') : t('knowledge.package', { name: pkg.package })}
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={selectId} className="block text-[12px] font-semibold text-muted">{t('knowledge.version')}</label>
          <select id={selectId} className="select w-auto" value={version.version} onChange={(event) => setChosen(Number(event.target.value))}>
            {versions.map((each) => (
              <option key={each.version} value={each.version}>
                {t('knowledge.versionOption', { version: each.version, status: t(`knowledge.status.${each.status}`, { defaultValue: each.status }) })}
              </option>
            ))}
          </select>
        </div>
        {comparable && (
          <PressedChoices label={t('knowledge.view.label')} choices={VIEWS} value={view} onChange={setView}
            display={(choice) => t(`knowledge.view.${choice}`, { version: pkg.approved_version })} className="tabs-track w-fit"
            pressedClassName="tab tab-active" idleClassName="tab" />
        )}
      </div>
      <VersionLine version={version} approvedVersion={pkg.approved_version} />
      <KindSwitcher kind={kind} onChange={setKind} />
      <KindDocument connection={connection} pkg={pkg} version={version} kind={kind} view={comparable ? view : 'read'} />
      {approvable(pkg, version) && <Approve key={version.version} connection={connection} pkg={pkg} version={version} />}
    </section>
  )
}

export function KnowledgeReview({ connection }: Readonly<{ connection: string }>) {
  const { t } = useTranslation('agents')
  const [publishing, setPublishing] = useState(false)
  const read = useKnowledgeRead(engineeringKnowledgeKeys.knowledge(connection), () => engineeringKnowledgeApi.knowledge(connection))
  if (read.isLoading || read.isError || read.data === undefined) {
    return <ReadPending read={read} loading={t('knowledge.loading')} failed={t('knowledge.failed')} skeleton="h-24" />
  }
  const { packages, rendering } = read.data
  if (packages.length === 0) return <p className="rounded-md border border-border p-3 text-sm text-muted">{t('knowledge.none')}</p>
  return (
    <section aria-label={t('knowledge.label')} className="space-y-3">
      {rendering !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-[12px] text-muted">{t('knowledge.rendering', { version: rendering.version })}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPublishing(true)}>
            <GitPullRequest size={14} aria-hidden="true" />{t('knowledge.publishButton')}
          </button>
        </div>
      )}
      {packages.map((pkg) => <PackageReview key={pkg.segment} connection={connection} pkg={pkg} />)}
      {publishing && <DocsPublishSheet connection={connection} kind="knowledge" onClose={() => setPublishing(false)} />}
    </section>
  )
}
