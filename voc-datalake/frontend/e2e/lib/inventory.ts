/**
 * The screens the suite visits, from reports/INVENTORY.md (routes.tsx and the
 * per-page `?tab=` parsers). `adminOnly` routes are expected to refuse the
 * plain user; `needs` names an id resolved at run time from list endpoints.
 */
export interface Screen {
  step: string
  path: string
  adminOnly?: boolean
  needs?: 'project' | 'agent' | 'feedback'
}

const ADMIN_TABS = ['brand', 'plugins', 'categories', 'users', 'ai', 'integrations', 'logs'] as const
// No 'mcp': the Export / MCP tab was removed (projects-mcp-removed.spec.ts covers `?tab=mcp`).
const PROJECT_TABS = ['overview', 'personas', 'product', 'documents'] as const
const AGENT_TABS = ['settings', 'triggers', 'personas', 'instructions', 'models', 'budget', 'workflow', 'runs'] as const

export const SCREENS: readonly Screen[] = [
  { step: 'home', path: '/' },
  { step: 'dashboard', path: '/dashboard' },
  { step: 'feedback-redirect', path: '/feedback' },
  { step: 'feedback-detail', path: '/feedback/{feedback}', needs: 'feedback' },
  { step: 'categories', path: '/categories' },
  { step: 'problems', path: '/problems' },
  { step: 'chat', path: '/chat' },
  { step: 'projects', path: '/projects' },
  ...PROJECT_TABS.map((tab): Screen => ({ step: `project-${tab}`, path: `/projects/{project}?tab=${tab}`, needs: 'project' })),
  { step: 'prioritization', path: '/prioritization' },
  { step: 'data-explorer', path: '/data-explorer', adminOnly: true },
  { step: 'scrapers', path: '/scrapers' },
  { step: 'feedback-forms', path: '/feedback-forms' },
  { step: 'memory', path: '/memory' },
  { step: 'company-vision', path: '/company?tab=vision' },
  { step: 'company-design', path: '/company?tab=design' },
  { step: 'agents', path: '/agents' },
  ...AGENT_TABS.map((tab): Screen => ({ step: `agent-${tab}`, path: `/agents/{agent}?tab=${tab}`, needs: 'agent' })),
  { step: 'connect', path: '/connect' },
  { step: 'account-profile', path: '/account?tab=profile' },
  { step: 'account-objectives', path: '/account?tab=objectives' },
  ...ADMIN_TABS.map((tab): Screen => ({ step: `admin-${tab}`, path: `/admin?tab=${tab}`, adminOnly: true })),
  { step: 'settings-redirect', path: '/settings?tab=ai', adminOnly: true },
  { step: 'not-found', path: '/e2e-no-such-page' },
]
