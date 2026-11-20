/**
 * @fileoverview The workspace's inspector (7.51.00): for the agent whose session is open, Changes, Files, Gate, Cost
 * (with its session as the supervisor keeps it) and Memory/Learn; and the run's own Assertions, Board (read only) and
 * Reports, which were the run monitor's panels. Each tab reads when it is shown
 * (and the Changes tab reads a file's part of the patch only when it is opened). (7.52.00 C2) A step selected on the
 * canvas opens its Step view instead (RunStepView.tsx: Agents, Setup, Checks); closing it comes back here.
 *
 * @module pages/Agents/RunWorkspace/Inspector
 */
import { useState } from 'react'
import { CircleDollarSign, FileDiff, FileText, FolderTree, GraduationCap, KanbanSquare, ListChecks, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../../components/IconTabs/IconTabs'
import { BoardPanel } from '../EngineeringRunPanels'
import { ReportsPanel } from '../EngineeringReports'
import { useEngineeringBoard } from '../useEngineeringRun'
import { ChangesTab } from './ChangesTab'
import { FilesTab } from './FilesTab'
import { GateTab } from './GateTab'
import { AssertionsTab } from './AssertionsTab'
import { CostTab } from './CostTab'
import { MemoryTab } from './MemoryTab'
import { RunStepView } from './RunStepView'
import type { EngineeringAgent, EngineeringOverview } from '../../../api/engineeringRunsApi'

const TABS = ['changes', 'files', 'gate', 'assertions', 'board', 'reports', 'cost', 'memory'] as const
type Tab = (typeof TABS)[number]
const TAB_ICONS = {
  changes: FileDiff, files: FolderTree, gate: ShieldCheck, assertions: ListChecks, board: KanbanSquare, reports: FileText,
  cost: CircleDollarSign, memory: GraduationCap,
}
/** The run's own tabs: shown whatever agent is open (or none). */
const RUN_TABS: ReadonlySet<Tab> = new Set(['assertions', 'board', 'reports'])

interface Props {
  runId: string
  overview: EngineeringOverview
  agent: EngineeringAgent | undefined
  live: boolean
  /** When the overview was read (the agent's ages are as of then). */
  readAt: number
  onOpen: (agent: string) => void
  /** (7.52.00) The step whose Step view is open (null: the agent's tabs), and its close. */
  step?: string | null
  onCloseStep?: () => void
}

/** The agents on the run's gate steps (the ones with a verdict to show). */
function gateAgentsOf(overview: EngineeringOverview): string[] {
  const steps = Object.keys(overview.gates)
  const lanes = steps.flatMap((step) => overview.lanes[step] ?? [])
  return [...new Set(lanes.flatMap((lane) => (lane.agent === null ? [] : [lane.agent])))]
}

function BoardTab({ runId, live }: Readonly<{ runId: string; live: boolean }>) {
  const board = useEngineeringBoard(runId, live)
  return <BoardPanel tasks={board.data ?? []} />
}

function RunTab({ tab, runId, overview, live }: Readonly<Omit<Props, 'agent' | 'readAt' | 'onOpen'> & { tab: Tab }>) {
  if (tab === 'board') return <BoardTab runId={runId} live={live} />
  if (tab === 'reports') return <ReportsPanel runId={runId} live={live} />
  const titles = new Map(overview.run.flow_definition?.nodes.map((node) => [node.id, node.data.title]) ?? [])
  return <AssertionsTab runId={runId} live={live} titles={titles} />
}

function AgentTab({ tab, runId, overview, agent, live, readAt, onOpen }: Readonly<Omit<Props, 'agent'> & { tab: Tab; agent: EngineeringAgent }>) {
  const name = agent.agent
  switch (tab) {
    case 'files': return <FilesTab runId={runId} agent={name} live={live} />
    case 'gate': return <GateTab runId={runId} agent={name} live={live} gateAgents={gateAgentsOf(overview)} onOpen={onOpen} />
    case 'cost': return <CostTab agent={agent} agents={overview.agents} readAt={readAt} />
    case 'memory': return <MemoryTab runId={runId} agent={name} live={live} />
    default: return <ChangesTab key={name} runId={runId} agent={name} repo={overview.run.repo} />
  }
}

export function Inspector({ agent, step = null, onCloseStep, ...props }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const [tab, setTab] = useState<Tab>('changes')
  if (step !== null) {
    return (
      <section className="card min-w-0 space-y-3" aria-label={t('runWorkspace.inspector.label')}>
        <RunStepView runId={props.runId} overview={props.overview} step={step} live={props.live} onOpen={props.onOpen}
          onClose={() => onCloseStep?.()} />
      </section>
    )
  }
  return (
    <section className="card min-w-0 space-y-3" aria-label={t('runWorkspace.inspector.label')}>
      <h2 className="text-sm font-medium text-text-strong">
        {agent === undefined ? t('runWorkspace.inspector.title') : t('runWorkspace.inspector.of', { agent: agent.agent })}
      </h2>
      <IconTabs tabs={TABS} active={tab} icons={TAB_ICONS} label={t('runWorkspace.inspector.tabs')}
        labelOf={(id) => t(`runWorkspace.inspector.tab.${id}`)} onSelect={setTab} wrap />
      <div role="tabpanel" aria-label={t(`runWorkspace.inspector.tab.${tab}`)} className="max-h-[70vh] overflow-y-auto">
        {RUN_TABS.has(tab) && <RunTab tab={tab} {...props} />}
        {!RUN_TABS.has(tab) && agent !== undefined && <AgentTab tab={tab} agent={agent} {...props} />}
        {!RUN_TABS.has(tab) && agent === undefined && <p className="text-sm text-muted">{t('runWorkspace.inspector.none')}</p>}
      </div>
    </section>
  )
}
