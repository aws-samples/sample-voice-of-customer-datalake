/**
 * The screens the suite visits (COVERAGE.md is the feature map): routes.tsx and the
 * per-page `?tab=` parsers. `adminOnly` routes are expected to refuse the plain
 * user; `needs` names an id resolved at run time from list endpoints.
 *
 * Every location is written in its canonical form (Account `?tab=` since 5.12, Admin
 * `?tab=&section=` since 5.09): a legacy id would redirect first and measure the
 * redirect, not the screen. The redirects themselves have their own steps
 * (`*-redirect`, surfaces.spec.ts).
 */
export interface Screen {
  step: string
  path: string
  adminOnly?: boolean
  needs?: 'project' | 'agent' | 'feedback' | 'workflow'
}

// pages/Settings/adminTabs.ts: every tab, and every section of a tab that has them.
const ADMIN_LOCATIONS = [
  'tab=brand',
  'tab=sources&section=plugins', 'tab=sources&section=integrations', 'tab=sources&section=inbox', 'tab=sources&section=radar',
  'tab=taxonomy&section=categories', 'tab=taxonomy&section=dimensions',
  'tab=access&section=policies', 'tab=access&section=users', 'tab=access&section=boards',
  'tab=ai',
  'tab=system&section=logs', 'tab=system&section=version',
] as const
// pages/ProjectDetail/types.ts TAB_IDS. No 'mcp': the Export / MCP tab was removed (projects-mcp-removed.spec.ts).
const PROJECT_TABS = ['overview', 'personas', 'product', 'documents', 'decisions', 'participants'] as const
// pages/Agents/AgentDetail.tsx TABS.
const AGENT_TABS = ['settings', 'triggers', 'personas', 'instructions', 'models', 'budget', 'workflow', 'runs'] as const
// pages/Account/accountSections.ts ACCOUNT_TAB_IDS.
const ACCOUNT_TABS = ['profile', 'preferences', 'briefing', 'objectives', 'access'] as const
// pages/Company/Company.tsx COMPANY_TABS.
const COMPANY_TABS = ['vision', 'design'] as const
// pages/Participants/Participants.tsx PARTICIPANT_TABS.
const PARTICIPANT_TABS = ['lists', 'people', 'asks'] as const
// pages/Memory/Memory.tsx MEMORY_TABS (review and imports are curator tabs; a non-curator lands on company).
const MEMORY_TABS = ['company', 'personal', 'review', 'imports'] as const

/** `tab=a&section=b` → `a-b`, `tab=a` → `a`. */
const adminStep = (query: string): string =>
  query.split('&').map((pair) => pair.split('=')[1] ?? pair).join('-')

export const SCREENS: readonly Screen[] = [
  { step: 'home', path: '/' },
  { step: 'dashboard', path: '/dashboard' },
  { step: 'feedback-redirect', path: '/feedback' },
  { step: 'feedback-detail', path: '/feedback/{feedback}', needs: 'feedback' },
  { step: 'review-modal', path: '/categories?review={feedback}', needs: 'feedback' },
  { step: 'categories', path: '/categories' },
  { step: 'problems', path: '/problems' },
  { step: 'radar', path: '/radar' },
  { step: 'chat', path: '/chat' },
  { step: 'projects', path: '/projects' },
  ...PROJECT_TABS.map((tab): Screen => ({ step: `project-${tab}`, path: `/projects/{project}?tab=${tab}`, needs: 'project' })),
  { step: 'prioritization', path: '/prioritization' },
  { step: 'data-explorer', path: '/data-explorer', adminOnly: true },
  { step: 'scrapers', path: '/scrapers' },
  { step: 'feedback-forms', path: '/feedback-forms' },
  ...PARTICIPANT_TABS.map((tab): Screen => ({ step: `participants-${tab}`, path: `/participants?tab=${tab}` })),
  // Feedback boards (5.36): the board list, and the seeded Sales board every deployment has.
  { step: 'feature-requests', path: '/feature-requests' },
  { step: 'feature-board', path: '/feature-requests/sales-feature-requests' },
  ...MEMORY_TABS.map((tab): Screen => ({ step: `memory-${tab}`, path: `/memory?tab=${tab}` })),
  ...COMPANY_TABS.map((tab): Screen => ({ step: `company-${tab}`, path: `/company?tab=${tab}` })),
  { step: 'company-mine-redirect', path: '/company?tab=mine' },
  { step: 'agents', path: '/agents' },
  // A non-admin has no library: `?tab=workflows` falls back to the agents view (not a redirect off the page).
  { step: 'agents-workflows', path: '/agents?tab=workflows' },
  { step: 'agents-workflows-redirect', path: '/agents/workflows' },
  { step: 'workflow-page', path: '/agents/workflows/{workflow}', needs: 'workflow' },
  ...AGENT_TABS.map((tab): Screen => ({ step: `agent-${tab}`, path: `/agents/{agent}?tab=${tab}`, needs: 'agent' })),
  { step: 'connect', path: '/connect' },
  ...ACCOUNT_TABS.map((tab): Screen => ({ step: `account-${tab}`, path: `/account?tab=${tab}` })),
  { step: 'account-section-redirect', path: '/account?section=mcp' },
  ...ADMIN_LOCATIONS.map((query): Screen => ({ step: `admin-${adminStep(query)}`, path: `/admin?${query}`, adminOnly: true })),
  { step: 'settings-redirect', path: '/settings?tab=ai', adminOnly: true },
  // Public pages (no session needed; the signed-in visit must not break them either).
  { step: 'unsubscribe', path: '/unsubscribe' },
  { step: 'board', path: '/board' },
  { step: 'board-slug', path: '/board/sales-feature-requests' },
  { step: 'board-login', path: '/board/login' },
  { step: 'not-found', path: '/e2e-no-such-page' },
]
