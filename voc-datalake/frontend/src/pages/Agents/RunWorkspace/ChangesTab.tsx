/**
 * @fileoverview The inspector's Changes tab (7.51.00, D51-1: the agent's patches in S3, the exact bytes the gate
 * judged and the committer pushed): one of its patches (the submitted one by default, else a checkpoint's), its files
 * each collapsed until opened and its part of the patch read only then (collapsed, fetched on open, keyed by the
 * patch, kept 30 s, and the notice when the list is partial), unified or split, and "Open on GitHub":
 * the pushed branch compared with its base and the pull request (`commit_url`, `pr_url`), for a change too large to
 * read here. A link is offered only on the host's own domain under the run's repository (runLinks.ts).
 *
 * Adapted from kirodotdev/KiroCrew `website/src/components/GitBranchChanges.tsx`, Apache-2.0 (THIRD-PARTY-LICENSES.md).
 *
 * @module pages/Agents/RunWorkspace/ChangesTab
 */
import { useId, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Columns2, ExternalLink, Rows2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { apiErrorStatus } from '../../../api/apiErrorStatus'
import { formatTime } from '../../../utils/dateUtils'
import { RUN_LINK_HOSTS, runLinkHref } from '../runLinks'
import { FileDiff } from './FileDiff'
import { useAgentChanges, useChangeFile } from './useRunWorkspace'
import type { AgentChanges, ChangedFile } from '../../../api/engineeringRunWorkspaceApi'

/** Past this many files or changed lines, the tab says the host shows the change better. */
const LARGE_FILES = 20
const LARGE_LINES = 1500
const HOST_NAMES: Readonly<Record<keyof typeof RUN_LINK_HOSTS, string>> = { github: 'GitHub', gitlab: 'GitLab' }

/** A link on the run's host, as runLinks.ts checks it, with its host's name; null for none that passes. */
function hostLink(url: string | null, repo: string): { href: string; host: string } | null {
  if (url === null) return null
  for (const host of ['github', 'gitlab'] as const) {
    const href = runLinkHref({ host, url }, repo)
    if (href !== null) return { href, host: HOST_NAMES[host] }
  }
  return null
}

function HostLinks({ changes, repo }: Readonly<{ changes: AgentChanges; repo: string }>) {
  const { t } = useTranslation('agents')
  const compare = hostLink(changes.commit_url, repo)
  const pull = hostLink(changes.pr_url, repo)
  if (compare === null && pull === null) return null
  return (
    <p className="flex flex-wrap gap-3 text-[12px]">
      {compare !== null && (
        <a className="link inline-flex items-center gap-1" href={compare.href} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={12} aria-hidden="true" /> {t('runWorkspace.changes.compareOn', { host: compare.host })}
        </a>
      )}
      {pull !== null && (
        <a className="link inline-flex items-center gap-1" href={pull.href} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={12} aria-hidden="true" /> {t('runWorkspace.changes.pullOn', { host: pull.host })}
        </a>
      )}
    </p>
  )
}

/** An opened file's part of the patch: read then, never for a binary file (which has no lines to show). */
function FilePart({ runId, agent, patchKey, file, split }: Readonly<{
  runId: string; agent: string; patchKey: string; file: ChangedFile; split: boolean
}>) {
  const { t } = useTranslation('agents')
  const part = useChangeFile(runId, agent, patchKey, file.path, !file.binary)
  if (file.binary) return <p className="px-2 pb-1 text-[12px] text-muted">{t('runWorkspace.changes.binary')}</p>
  if (part.isLoading) return <p className="px-2 pb-1 text-[12px] text-muted">{t('runWorkspace.loading')}</p>
  if (part.data === undefined) return <p role="alert" className="px-2 pb-1 text-[12px] text-danger">{t('runWorkspace.changes.fileFailed')}</p>
  return (
    <div className="border-t border-border">
      {part.data.truncated && <p role="status" className="px-2 py-1 text-[12px] text-warn">{t('runWorkspace.changes.fileCut')}</p>}
      <FileDiff patch={part.data.patch} split={split} />
    </div>
  )
}

function FileCounts({ file }: Readonly<{ file: ChangedFile }>) {
  const { t } = useTranslation('agents')
  if (file.binary) return <span className="shrink-0 text-[12px] text-muted">{t('runWorkspace.changes.binaryShort')}</span>
  return <span className="shrink-0 tabular-nums"><span className="text-ok">+{file.additions}</span> <span className="text-danger">-{file.deletions}</span></span>
}

function FileRow({ runId, agent, patchKey, file, split }: Readonly<{
  runId: string; agent: string; patchKey: string; file: ChangedFile; split: boolean
}>) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const regionId = useId()
  return (
    <li className="rounded-md border border-border">
      <button type="button" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-[12px] hover:bg-bg-hover">
        <ChevronRight size={12} aria-hidden="true" className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
          {file.old_path === undefined ? file.path : t('runWorkspace.changes.renamed', { from: file.old_path, to: file.path })}
        </span>
        <span className="shrink-0 text-[12px] text-muted">{t(`runWorkspace.changes.status.${file.status}`, { defaultValue: file.status })}</span>
        <FileCounts file={file} />
      </button>
      <div id={regionId}>
        {open && <FilePart runId={runId} agent={agent} patchKey={patchKey} file={file} split={split} />}
      </div>
    </li>
  )
}

function PatchPicker({ changes, onPick }: Readonly<{ changes: AgentChanges; onPick: (key: string) => void }>) {
  const { t, i18n } = useTranslation('agents')
  const id = useId()
  if (changes.patches.length < 2) return null
  return (
    <span className="inline-flex items-center gap-1 text-[12px]">
      <label htmlFor={id} className="text-muted">{t('runWorkspace.changes.patch')}</label>
      <select id={id} className="select w-auto text-[12px]" value={changes.key ?? ''} onChange={(event) => onPick(event.target.value)}>
        {changes.patches.map((patch) => (
          <option key={patch.key} value={patch.key}>
            {t(`runWorkspace.changes.sources.${patch.source}`, { defaultValue: patch.source })} · {formatTime(patch.at, i18n.language)}
          </option>
        ))}
      </select>
    </span>
  )
}

function SplitToggle({ split, onToggle }: Readonly<{ split: boolean; onToggle: () => void }>) {
  const { t } = useTranslation('agents')
  const Icon = split ? Rows2 : Columns2
  return (
    <button type="button" className="btn btn-secondary btn-sm ml-auto" aria-pressed={split} onClick={onToggle}>
      <Icon size={14} aria-hidden="true" /> {t(split ? 'runWorkspace.changes.unified' : 'runWorkspace.changes.split')}
    </button>
  )
}

/** The size notice: the list is partial, or the change is too large to read well here. */
function SizeNotice({ changes }: Readonly<{ changes: AgentChanges }>) {
  const { t } = useTranslation('agents')
  const lines = changes.files.reduce((sum, file) => sum + file.additions + file.deletions, 0)
  if (changes.truncated) return <p role="status" className="text-[12px] text-warn">{t('runWorkspace.changes.partial')}</p>
  if (changes.files.length <= LARGE_FILES && lines <= LARGE_LINES) return null
  return <p role="status" className="text-[12px] text-warn">{t('runWorkspace.changes.large')}</p>
}

function ChangesView({ runId, agent, repo, changes, onPick }: Readonly<{
  runId: string; agent: string; repo: string; changes: AgentChanges; onPick: (key: string) => void
}>) {
  const { t } = useTranslation('agents')
  const [split, setSplit] = useState(false)
  const patchKey = changes.key
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <PatchPicker changes={changes} onPick={onPick} />
        <SplitToggle split={split} onToggle={() => setSplit(!split)} />
      </div>
      <HostLinks changes={changes} repo={repo} />
      <SizeNotice changes={changes} />
      {patchKey === null || changes.files.length === 0
        ? <p className="text-sm text-muted">{t('runWorkspace.changes.none')}</p>
        : (
          <ul className="space-y-1" aria-label={t('runWorkspace.changes.files')}>
            {changes.files.map((file) => (
              <FileRow key={`${patchKey}:${file.path}`} runId={runId} agent={agent} patchKey={patchKey} file={file} split={split} />
            ))}
          </ul>
        )}
    </div>
  )
}

export function ChangesTab({ runId, agent, repo }: Readonly<{ runId: string; agent: string; repo: string }>) {
  const { t } = useTranslation('agents')
  const [key, setKey] = useState('')
  const changes = useAgentChanges(runId, agent, key)
  if (changes.isLoading) return <div className="skeleton h-24" />
  if (changes.isError && apiErrorStatus(changes.error) === 404) return <p className="text-sm text-muted">{t('runWorkspace.changes.none')}</p>
  if (changes.data === undefined) return <LoadFailed onRetry={() => { void changes.refetch() }} retrying={changes.isFetching} />
  return <ChangesView runId={runId} agent={agent} repo={repo} changes={changes.data} onPick={setKey} />
}
