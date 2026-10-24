/**
 * @fileoverview One workflow from the library, outside any agent
 * (`/agents/workflows/:workflowId`): the same editor as an agent's Workflow
 * tab. Admins edit and save; "Save as" creates the copy and opens it here;
 * the built-in template stays copy-only, and everyone else reads.
 *
 * @module pages/Agents/WorkflowPage
 */
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { WorkflowEditor } from '../../components/WorkflowEditor/WorkflowEditor'
import { useIsAdmin } from '../../store/authStore'
import { BackToAgents } from './BackToAgents'
import { workflowPath } from './workflowPaths'
import type { WorkflowView } from '../../api/workflowsApi'

/** What the page hands itself when it opens a workflow it just made (router state, untrusted). */
const OpenedStateSchema = z.object({ savedAsName: z.string().min(1) })

export default function WorkflowPage() {
  const { t } = useTranslation('agents')
  // The route is `agents/workflows/:workflowId` (routes.tsx, pageContext.ts, Breadcrumbs).
  const { workflowId = '' } = useParams()
  const isAdmin = useIsAdmin()
  const navigate = useNavigate()
  const location = useLocation()
  const opened = OpenedStateSchema.safeParse(location.state)
  const notice = opened.success ? t('editor.savedAsOpened', { name: opened.data.savedAsName }) : undefined
  const onSavedAs = (workflow: WorkflowView) => {
    void navigate(workflowPath(workflow.workflow_id), { state: { savedAsName: workflow.name } })
  }
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0">
      <BackToAgents />
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('workflowPage.title')}</h1>
        <p className="text-sm text-muted mt-1 max-w-prose">{t('workflowPage.subtitle')}</p>
      </div>
      <WorkflowEditor key={workflowId} workflowId={workflowId} canEdit={isAdmin} onSavedAs={onSavedAs} notice={notice} />
    </div>
  )
}
