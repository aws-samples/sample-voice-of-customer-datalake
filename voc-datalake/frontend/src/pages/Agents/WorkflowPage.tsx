/**
 * @fileoverview One workflow from the library, outside any agent
 * (`/agents/workflows/:workflowId`): the same editor as an agent's Workflow
 * tab. Admins edit and save; "Save as" creates the copy and opens it here;
 * the built-in template stays copy-only, and everyone else reads. On a saved
 * engineering flow, where the deployment has the engineering module
 * (`features.engineering`), an admin has "Start a run" (StartRunDialog), which
 * opens the run monitor on the new run; a run uses the saved version, so it is
 * off, saying why, while the editor has unsaved changes.
 *
 * @module pages/Agents/WorkflowPage
 */
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Play } from 'lucide-react'
import { z } from 'zod'
import { WorkflowEditor } from '../../components/WorkflowEditor/WorkflowEditor'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { isEngineeringAvailable } from '../../runtimeConfig'
import { useIsAdmin } from '../../store/authStore'
import { BackToAgents } from './BackToAgents'
import { StartRunDialog } from './StartRunDialog'
import { workflowPath } from './workflowPaths'
import type { WorkflowView } from '../../api/workflowsApi'

/** What the page hands itself when it opens a workflow it just made (router state, untrusted). */
const OpenedStateSchema = z.object({ savedAsName: z.string().min(1) })

/** "Start a run" of the saved engineering flow (the editor's own read of it: one cache entry); none for another kind. */
function StartRunAction({ workflowId, dirty }: Readonly<{ workflowId: string; dirty: boolean }>) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const hintId = useId()
  const { data } = useQuery({ queryKey: workflowsKeys.detail(workflowId), queryFn: () => workflowsApi.get(workflowId) })
  const workflow = data?.workflow
  if (workflow?.kind !== 'engineering' || workflow.status === 'archived') return null
  // A run runs the saved version: with unsaved changes it is not offered until they are saved.
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button type="button" className="btn btn-primary" disabled={dirty} aria-describedby={dirty ? hintId : undefined}
        onClick={() => setOpen(true)}>
        <Play size={14} aria-hidden="true" /> {t('startRun.action')}
      </button>
      {dirty && <p id={hintId} className="text-[12px] text-muted">{t('startRun.saveFirst')}</p>}
      {open && <StartRunDialog workflow={workflow} onClose={() => setOpen(false)} />}
    </div>
  )
}

export default function WorkflowPage() {
  const { t } = useTranslation('agents')
  // The route is `agents/workflows/:workflowId` (routes.tsx, pageContext.ts, Breadcrumbs).
  const { workflowId = '' } = useParams()
  const isAdmin = useIsAdmin()
  // Whether the editor's draft has unsaved changes (a run starts from the saved version).
  const [dirty, setDirty] = useState(false)
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('workflowPage.title')}</h1>
          <p className="text-sm text-muted mt-1 max-w-prose">{t('workflowPage.subtitle')}</p>
        </div>
        {isAdmin && isEngineeringAvailable() && <StartRunAction key={workflowId} workflowId={workflowId} dirty={dirty} />}
      </div>
      <WorkflowEditor key={workflowId} workflowId={workflowId} canEdit={isAdmin} onSavedAs={onSavedAs} notice={notice}
        onDirtyChange={setDirty} />
    </div>
  )
}
