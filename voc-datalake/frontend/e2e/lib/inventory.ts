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

// The 5.09 tabs at their canonical `?tab=&section=` (the pre-5.09 ids are mapped: adminTabs.test.ts).
const ADMIN_TABS = ['tab=brand', 'tab=sources&section=plugins', 'tab=taxonomy&section=categories', 'tab=access&section=users', 'tab=ai', 'tab=sources&section=integrations', 'tab=system&section=logs'] as const
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
  { step: 'account-profile', path: '/account?section=profile' },
  { step: 'account-objectives', path: '/account?section=objectives' },
  ...ADMIN_TABS.map((query): Screen => ({ step: `admin-${query.split('=').at(-1) ?? query}`, path: `/admin?${query}`, adminOnly: true })),
  { step: 'settings-redirect', path: '/settings?tab=ai', adminOnly: true },
  { step: 'not-found', path: '/e2e-no-such-page' },
]
