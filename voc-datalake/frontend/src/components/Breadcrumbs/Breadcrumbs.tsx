/**
 * @fileoverview Breadcrumb navigation component.
 *
 * Displays hierarchical navigation path based on current route.
 * Hidden on home page.
 * Mobile-responsive with truncation and horizontal scroll.
 *
 * Labels come from the shipped `common:breadcrumbs` catalogue via
 * ./routeCrumbs — this file holds no English of its own, and no path segment
 * reaches the DOM unlabelled.
 *
 * @module components/Breadcrumbs
 */

import { Link, useLocation } from 'react-router-dom'
import { ChevronRight, Home } from 'lucide-react'
import { skipToken, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import clsx from 'clsx'
import { agentsKeys } from '../../api/agentsApi'
import { workflowsKeys } from '../../api/workflowsApi'
import { projectKey } from '../../api/projectQueryKeys'
import { buildCrumbs } from './routeCrumbs'

/**
 * The one field a crumb needs off the project cache entry. Lenient by
 * construction: a failed parse (nothing cached yet, an error state, a record
 * saved before `name` existed) leaves the generic label in place rather than
 * throwing inside the page header.
 */
const ProjectNameSchema = z.object({
  project: z.object({ name: z.string().trim().min(1) }),
})

/** Same idea for an autonomous agent (`/agents/:id`). */
const AgentNameSchema = z.object({ name: z.string().trim().min(1) })

/** And for a library workflow (`/agents/workflows/:workflowId`, the editor's workflowsKeys.detail entry). */
const WorkflowNameSchema = z.object({ workflow: z.object({ name: z.string().trim().min(1) }) })

/** Which record the path addresses: a project, an agent, or a library workflow (`/agents/workflows/:id`). */
function recordIds(pathSegments: readonly string[]): { projectId?: string; agentId?: string; workflowId?: string } {
  const [first, second, third] = pathSegments
  if (first === 'projects') return { projectId: second }
  if (first !== 'agents') return {}
  return second === 'workflows' ? { workflowId: third } : { agentId: second }
}

/**
 * The display name for the record the current route addresses, if the page has
 * already loaded it. At most one record route is active at a time, so a single
 * name covers them all.
 *
 * Projects, agents and library workflows are the records with a name to show: a feedback item has no title
 * field (see FeedbackItem), so `/feedback/:id` keeps its generic label.
 *
 * The entry is ProjectDetail's, via useProjectData — hence the shared `projectKey`
 * — and it is observed with `skipToken`, i.e. read-only: the header must not issue
 * a request of its own, nor race that page for one. The subscription is live
 * either way, so the crumb fills in the moment the page's own query resolves.
 */
function useRecordName(pathSegments: readonly string[]): string | undefined {
  const { projectId, agentId, workflowId } = recordIds(pathSegments)
  const { data } = useQuery({ queryKey: projectKey(projectId), queryFn: skipToken })
  // AgentDetail's own entry (agentsKeys.detail), observed read-only like the project one.
  const { data: agent } = useQuery({ queryKey: agentsKeys.detail(agentId ?? ''), queryFn: skipToken, enabled: agentId !== undefined })
  const { data: workflow } = useQuery({
    queryKey: workflowsKeys.detail(workflowId ?? ''), queryFn: skipToken, enabled: workflowId !== undefined,
  })
  return ProjectNameSchema.safeParse(data).data?.project.name
    ?? AgentNameSchema.safeParse(agent).data?.name
    ?? WorkflowNameSchema.safeParse(workflow).data?.workflow.name
}

export default function Breadcrumbs() {
  const location = useLocation()
  const { t } = useTranslation()
  const pathSegments = location.pathname.split('/').filter(Boolean)
  const recordName = useRecordName(pathSegments)

  // Don't show breadcrumbs on home page
  if (pathSegments.length === 0) {
    return null
  }

  const breadcrumbs = buildCrumbs(pathSegments, t, recordName)

  return (
    <nav 
      className="flex flex-wrap items-center gap-x-1.5 sm:gap-x-2 gap-y-0.5 text-xs sm:text-sm text-text"
      aria-label="Breadcrumb"
    >
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1
        // Below `sm` only Home and the current page fit. An intermediate crumb
        // collapses entirely — separator included — instead of leaving an
        // empty link between two chevrons ("⌂ > > Page").
        const isMiddle = !isLast && !crumb.isHome
        
        return (
          <div key={crumb.path} className={clsx('items-center gap-1.5 sm:gap-2', isLast ? 'min-w-0' : 'flex-shrink-0', isMiddle ? 'hidden sm:flex' : 'flex')}>
            {index > 0 && (
              <ChevronRight 
                size={14} 
                className="text-muted-strong flex-shrink-0" 
                aria-hidden="true" 
              />
            )}
            
            {isLast ? (
              // Wraps, never cut: a long project name used to end at 120 px ("Q1 Product Improv…").
              <span 
                className="text-text-strong font-medium flex items-center gap-1 sm:gap-1.5 min-w-0"
                aria-current="page"
              >
                {crumb.isHome && <Home size={14} className="flex-shrink-0" aria-hidden="true" />}
                <span className="min-w-0 break-words">{crumb.label}</span>
              </span>
            ) : (
              <Link
                to={crumb.path}
                // The label is hidden below `sm`, where an intermediate crumb has
                // no icon either — without this the link has no accessible name
                // at all on a phone.
                aria-label={crumb.label}
                className={clsx(
                  'hover:text-accent-text active:text-accent-hover transition-colors flex items-center gap-1 sm:gap-1.5 py-1',
                  crumb.isHome && 'text-muted'
                )}
              >
                {crumb.isHome && <Home size={14} className="flex-shrink-0" aria-hidden="true" />}
                <span className="hidden sm:inline">{crumb.label}</span>
              </Link>
            )}
          </div>
        )
      })}
    </nav>
  )
}
