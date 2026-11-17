/**
 * @fileoverview The run's own panels below the workspace (the run monitor's, kept as they were): the Agents (each
 * session as the supervisor keeps it, with its signals), the Board (with a person's actions on its tasks), the
 * Conversation (where a person answers the conductor, or an agent on the thread its own question opened) and the
 * Reports (each version's Markdown).
 *
 * @module pages/Agents/RunWorkspace/RunPanels
 */
import { useState } from 'react'
import { Bot, FileText, KanbanSquare, MessagesSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../../components/IconTabs/IconTabs'
import { useMySub } from '../../../store/authStore'
import { AgentsPanel, BoardPanel } from '../EngineeringRunPanels'
import { ConversationPanel } from '../EngineeringConversation'
import { ReportsPanel } from '../EngineeringReports'
import { useEngineeringBoard, useEngineeringConversation } from '../useEngineeringRun'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'

const TABS = ['agents', 'board', 'conversation', 'reports'] as const
type Tab = (typeof TABS)[number]
const TAB_ICONS = { agents: Bot, board: KanbanSquare, conversation: MessagesSquare, reports: FileText }

export function RunPanels({ runId, overview, live, canAct, readAt }: Readonly<{
  runId: string; overview: EngineeringOverview; live: boolean; canAct: boolean; readAt: number
}>) {
  const { t } = useTranslation('agents')
  const [tab, setTab] = useState<Tab>('agents')
  const me = useMySub()
  const board = useEngineeringBoard(runId, live)
  const conversation = useEngineeringConversation(runId, live)
  const tasks = board.data ?? []
  return (
    <section className="card min-w-0 space-y-3">
      <IconTabs tabs={TABS} active={tab} icons={TAB_ICONS} label={t('engineeringRun.panels')}
        labelOf={(id) => t(`engineeringRun.tabs.${id}`)} onSelect={setTab} />
      <div role="tabpanel" aria-label={t(`engineeringRun.tabs.${tab}`)} className="max-h-[70vh] overflow-y-auto">
        {tab === 'agents' && <AgentsPanel runId={runId} agents={overview.agents} tasks={tasks} isAdmin={canAct && live}
          now={readAt} />}
        {tab === 'board' && <BoardPanel tasks={tasks} actor={canAct && live && me !== '' ? { runId, me } : undefined} />}
        {tab === 'conversation' && (
          <ConversationPanel runId={runId} messages={conversation.data?.messages ?? []} agents={overview.agents}
            isAdmin={canAct} live={live} />
        )}
        {tab === 'reports' && <ReportsPanel runId={runId} live={live} />}
      </div>
    </section>
  )
}
