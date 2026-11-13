/**
 * @fileoverview A default engineering flow's unsaved copy (`/agents/workflows/templates/:templateId`, the library's
 * "Start from a template"): the workflow editor on the template's definition as the server holds it
 * (`GET /workflows/templates`), named and described in the person's language. Nothing is stored until they Save,
 * which creates the flow through the library's own create and opens it on its own page (`/agents/workflows/:workflowId`). Offered only where the deployment has the engineering module
 * (`features.engineering`) and to administrators: anyone else is told it is for administrators (the server's 403 says
 * the same), and an unknown template, or one the server does not offer (404 where the module is off), says it is not
 * available; both link back to the library. Any other failed read says so, with a retry.
 *
 * @module pages/Agents/WorkflowTemplatePage
 */
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { WorkflowEditor } from '../../components/WorkflowEditor/WorkflowEditor'
import { fetchServedTemplates, findEngineeringTemplate, servedTemplatesKey, templateCopy } from '../../api/engineeringTemplates'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { isEngineeringAvailable } from '../../runtimeConfig'
import { useIsAdmin } from '../../store/authStore'
import { BackToAgents } from './BackToAgents'
import { workflowPath } from './workflowPaths'
import type { WorkflowView } from '../../api/workflowsApi'

/** The way back when the template is not there to copy: for this person (not an administrator), or here at all. */
function NotAvailable({ adminOnly }: Readonly<{ adminOnly: boolean }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="card space-y-2">
      <p className="text-sm text-text">{t(adminOnly ? 'templatePage.adminOnly' : 'templatePage.notFound')}</p>
      <Link to="/agents?tab=workflows" className="btn btn-secondary btn-sm">{t('templatePage.backToLibrary')}</Link>
    </div>
  )
}

type Wait = 'loading' | 'adminOnly' | 'notAvailable' | 'failed'

/**
 * Why the copy is not open yet: the server's answer on its way; not an administrator (or the server's 403); not
 * offered (an unknown template, no module, the server's 404); or the read failed otherwise (a 5xx, a dropped
 * connection), which says so and offers a retry rather than calling the template missing.
 */
function waitingOn(template: unknown, isAdmin: boolean, served: { isPending: boolean; error: unknown }): Wait {
  if (template === undefined) return 'notAvailable'
  if (!isAdmin) return 'adminOnly'
  if (served.isPending) return 'loading'
  const status = apiErrorStatus(served.error)
  if (status === 403) return 'adminOnly'
  return served.error === null || status === 404 ? 'notAvailable' : 'failed'
}

function TemplateWait({ wait, onRetry, retrying }: Readonly<{ wait: Wait; onRetry: () => void; retrying: boolean }>) {
  const { t } = useTranslation('agents')
  if (wait === 'loading') return <div className="skeleton h-[480px]" />
  if (wait === 'failed') return <LoadFailed message={t('templatePage.loadFailed')} onRetry={onRetry} retrying={retrying} />
  return <NotAvailable adminOnly={wait === 'adminOnly'} />
}

export default function WorkflowTemplatePage() {
  const { t } = useTranslation('agents')
  // The route is `agents/workflows/templates/:templateId` (routes.tsx, pageContext.ts, Breadcrumbs).
  const { templateId = '' } = useParams()
  const isAdmin = useIsAdmin()
  const navigate = useNavigate()
  const template = isEngineeringAvailable() ? findEngineeringTemplate(templateId) : undefined
  // The server's copy: it answers only where the module is deployed (404 elsewhere), and only to an administrator
  // (403): a person who is not one is told so without asking, and a 403 says the same.
  const served = useQuery({
    queryKey: servedTemplatesKey, queryFn: fetchServedTemplates, enabled: template !== undefined && isAdmin, retry: false,
  })
  const definition = served.data?.get(templateId)
  const onCreated = (workflow: WorkflowView) => {
    void navigate(workflowPath(workflow.workflow_id), { replace: true, state: { savedAsName: workflow.name } })
  }
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0">
      <BackToAgents />
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('templatePage.title')}</h1>
        <p className="text-sm text-muted mt-1 max-w-prose">{t('templatePage.subtitle')}</p>
      </div>
      {template === undefined || definition === undefined
        ? <TemplateWait wait={waitingOn(template, isAdmin, served)} onRetry={() => void served.refetch()} retrying={served.isFetching} />
        : (
          <WorkflowEditor key={templateId} workflowId="" canEdit={isAdmin} onSavedAs={onCreated}
            unsaved={templateCopy(definition, t(template.nameKey), t(template.descriptionKey))} />
        )}
    </div>
  )
}
