/**
 * @fileoverview The editor's revision History: a "History" button opening a
 * dialog that lists the workflow's saved revisions (newest first, from
 * `GET /workflows/{id}`) and shows one of them (`GET /workflows/{id}/revisions/{n}`):
 * its name, step and arrow counts, and what restoring it would change compared
 * with the current revision (the shared workflow diff).
 *
 * Everyone who can open the workflow browses its history. "Restore into
 * editor" is offered only to an editor (admins): it hands the revision's
 * definition to the host, which loads it into the DRAFT — nothing is saved;
 * the usual Save writes it as a new revision.
 *
 * @module components/WorkflowEditor/WorkflowHistory
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { History, RotateCcw } from 'lucide-react'
import clsx from 'clsx'
import DialogTrigger from '../ModalShell/DialogTrigger'
import { WorkflowDiffView } from './WorkflowDiffView'
import { diffDefinitions } from './diff'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { formatDateTime } from '../../utils/dateUtils'
import type { WorkflowDefinition, WorkflowRevision } from '../../api/workflowsApi'

/** What a restore hands the host: the revision number and its definition. */
export interface RestoredRevision {
  readonly revision: number
  readonly definition: WorkflowDefinition
}

interface WorkflowHistoryProps {
  readonly workflowId: string
  /** The saved revisions, newest first (the decoded `revisions` of `GET /workflows/{id}`). */
  readonly revisions: readonly WorkflowRevision[]
  /** The stored current revision the editor loaded. */
  readonly currentRevision: number
  readonly currentDefinition: WorkflowDefinition | null
  /** Admins only; without it the history is read-only. */
  readonly onRestore?: (restored: RestoredRevision) => void
}

function RevisionRow({ item, current, selected, onSelect }: Readonly<{
  item: WorkflowRevision; current: boolean; selected: boolean; onSelect: () => void
}>) {
  const { t, i18n } = useTranslation('agents')
  const savedAt = formatDateTime(item.saved_at, i18n.language)
  return (
    <li>
      <button type="button" aria-current={selected ? 'true' : undefined} onClick={onSelect}
        className={clsx('w-full text-left rounded-md px-2.5 py-2 focus-ring', selected ? 'bg-accent-subtle' : 'hover:bg-bg-hover')}>
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-strong font-mono">{t('editor.revision', { n: item.revision })}</span>
          {current && <span className="badge badge-info">{t('editor.history.current')}</span>}
        </span>
        <span className="block text-[12px] text-muted">
          {item.saved_by_username === null ? t('editor.history.builtinRevision') : t('editor.history.savedBy', { name: item.saved_by_username })}
        </span>
        {savedAt !== '' && <span className="block text-[12px] text-muted font-mono">{savedAt}</span>}
      </button>
    </li>
  )
}

function RevisionDetail({ workflowId, revision, currentRevision, currentDefinition, onRestore }: Readonly<{
  workflowId: string; revision: number; currentRevision: number; currentDefinition: WorkflowDefinition | null
  onRestore?: (restored: RestoredRevision) => void
}>) {
  const { t } = useTranslation('agents')
  const query = useQuery({
    queryKey: workflowsKeys.revision(workflowId, revision),
    queryFn: () => workflowsApi.getRevision(workflowId, revision),
    // A saved revision never changes.
    staleTime: Infinity,
    retry: false,
  })
  if (query.isLoading) return <p role="status" className="text-sm text-muted">{t('editor.history.loading')}</p>
  if (query.isError || query.data === undefined) return <p role="alert" className="text-sm text-danger">{t('editor.history.loadFailed')}</p>
  const { definition, name } = query.data
  if (definition === null) return <p role="alert" className="text-sm text-danger">{t('editor.history.unreadable')}</p>
  const isCurrent = revision === currentRevision
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-text-strong">{name || definition.name}</p>
        <p className="text-[12px] text-muted">
          {t('editor.history.steps', { count: definition.nodes.length })} · {t('editor.history.arrows', { count: definition.edges.length })}
        </p>
      </div>
      {isCurrent ? <p className="text-[12px] text-muted">{t('editor.history.isCurrent')}</p> : (
        <section aria-label={t('editor.history.changesTitle')} className="space-y-1">
          <p className="text-[12px] font-medium text-text">{t('editor.history.changesTitle')}</p>
          <WorkflowDiffView diff={diffDefinitions(currentDefinition, definition)} before={currentDefinition} after={definition} />
        </section>
      )}
      {onRestore !== undefined && (
        <div className="space-y-1 border-t border-border pt-3">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onRestore({ revision, definition })}>
            <RotateCcw size={14} aria-hidden="true" /> {t('editor.history.restore')}
          </button>
          <p className="text-[12px] text-muted">{t('editor.history.restoreHint')}</p>
        </div>
      )}
    </div>
  )
}

function HistoryBody({ headingId, close, history }: Readonly<{ headingId: string; close: () => void; history: WorkflowHistoryProps }>) {
  const { t } = useTranslation('agents')
  const { workflowId, revisions, currentRevision, currentDefinition, onRestore } = history
  const [selected, setSelected] = useState(revisions.some((r) => r.revision === currentRevision) ? currentRevision : revisions[0]?.revision)
  const restore = onRestore === undefined ? undefined : (restored: RestoredRevision) => { close(); onRestore(restored) }
  return (
    <div className="p-4 space-y-3">
      <h3 id={headingId} className="font-semibold tracking-tight text-text-strong">{t('editor.history.title')}</h3>
      {revisions.length === 0 || selected === undefined ? <p className="text-sm text-muted">{t('editor.history.empty')}</p> : (
        <div className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
          <ul aria-label={t('editor.history.listLabel')} className="max-h-[420px] overflow-y-auto space-y-1">
            {revisions.map((item) => (
              <RevisionRow key={item.revision} item={item} current={item.revision === currentRevision}
                selected={item.revision === selected} onSelect={() => setSelected(item.revision)} />
            ))}
          </ul>
          <div className="min-w-0 max-h-[420px] overflow-y-auto">
            <RevisionDetail workflowId={workflowId} revision={selected} currentRevision={currentRevision}
              currentDefinition={currentDefinition} onRestore={restore} />
          </div>
        </div>
      )}
      <div className="flex justify-end">
        <button type="button" className="btn btn-secondary btn-sm" onClick={close}>{t('editor.history.close')}</button>
      </div>
    </div>
  )
}

export function WorkflowHistory(props: WorkflowHistoryProps) {
  const { t } = useTranslation('agents')
  return (
    <DialogTrigger triggerClassName="btn btn-ghost btn-sm"
      trigger={<><History size={14} aria-hidden="true" /> {t('editor.history.open')}</>}
      panelClassName="max-w-3xl">
      {({ headingId, close }) => <HistoryBody headingId={headingId} close={close} history={props} />}
    </DialogTrigger>
  )
}
