/**
 * @fileoverview The workspace's inspector (7.51.00), for the agent whose session is open: Changes, Files, Gate,
 * Assertions (the run's), Cost and Memory/Learn. Each tab reads when it is shown (and the Changes tab reads a file's
 * part of the patch only when it is opened).
 *
 * @module pages/Agents/RunWorkspace/Inspector
 */
import { useState } from 'react'
import { CircleDollarSign, FileDiff, FolderTree, GraduationCap, ListChecks, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../../components/IconTabs/IconTabs'
import { ChangesTab } from './ChangesTab'
import { FilesTab } from './FilesTab'
import { GateTab } from './GateTab'
import { AssertionsTab } from './AssertionsTab'
import { CostTab } from './CostTab'
import { MemoryTab } from './MemoryTab'
import type { EngineeringAgent, EngineeringOverview } from '../../../api/engineeringRunsApi'

const TABS = ['changes', 'files', 'gate', 'assertions', 'cost', 'memory'] as const
type Tab = (typeof TABS)[number]
const TAB_ICONS = { changes: FileDiff, files: FolderTree, gate: ShieldCheck, assertions: ListChecks, cost: CircleDollarSign, memory: GraduationCap }

interface Props {
  runId: string
  overview: EngineeringOverview
  agent: EngineeringAgent | undefined
  live: boolean
  onOpen: (agent: string) => void
}

/** The agents on the run's gate steps (the ones with a verdict to show). */
function gateAgentsOf(overview: EngineeringOverview): string[] {
  const steps = Object.keys(overview.gates)
  const lanes = steps.flatMap((step) => overview.lanes[step] ?? [])
  return [...new Set(lanes.flatMap((lane) => (lane.agent === null ? [] : [lane.agent])))]
}

function TabBody({ tab, runId, overview, agent, live, onOpen }: Readonly<Omit<Props, 'agent'> & { tab: Tab; agent: EngineeringAgent }>) {
  const name = agent.agent
  switch (tab) {
    case 'changes': return <ChangesTab key={name} runId={runId} agent={name} repo={overview.run.repo} />
    case 'files': return <FilesTab runId={runId} agent={name} live={live} />
    case 'gate': return <GateTab runId={runId} agent={name} live={live} gateAgents={gateAgentsOf(overview)} onOpen={onOpen} />
    case 'assertions': {
      const titles = new Map(overview.run.flow_definition?.nodes.map((node) => [node.id, node.data.title]) ?? [])
      return <AssertionsTab runId={runId} live={live} titles={titles} />
    }
    case 'cost': return <CostTab agent={agent} agents={overview.agents} />
    case 'memory': return <MemoryTab runId={runId} agent={name} live={live} />
  }
}

export function Inspector({ agent, ...props }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const [tab, setTab] = useState<Tab>('changes')
  return (
    <section className="card min-w-0 space-y-3" aria-label={t('runWorkspace.inspector.label')}>
      <h2 className="text-sm font-medium text-text-strong">
        {agent === undefined ? t('runWorkspace.inspector.title') : t('runWorkspace.inspector.of', { agent: agent.agent })}
      </h2>
      {agent === undefined
        ? <p className="text-sm text-muted">{t('runWorkspace.inspector.none')}</p>
        : (
          <>
            <IconTabs tabs={TABS} active={tab} icons={TAB_ICONS} label={t('runWorkspace.inspector.tabs')}
              labelOf={(id) => t(`runWorkspace.inspector.tab.${id}`)} onSelect={setTab} />
            <div role="tabpanel" aria-label={t(`runWorkspace.inspector.tab.${tab}`)} className="max-h-[70vh] overflow-y-auto">
              <TabBody tab={tab} agent={agent} {...props} />
            </div>
          </>
        )}
    </section>
  )
}
