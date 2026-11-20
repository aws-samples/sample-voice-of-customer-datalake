/**
 * The screens the suite visits (COVERAGE.md is the feature map): routes.tsx and each
 * area's path builder (`*Paths.ts`). `adminOnly` routes are expected to refuse the plain
 * user; `needs` names an id resolved at run time from list endpoints.
 *
 * Every location is its path (7.49.00: a tab, a section and a view are path segments,
 * `/admin/<tab>/<section>`, `/account/<tab>`, `/projects/<id>/<tab>`); no query names a
 * place, and an old query link is not redirected. The kept redirects of a moved page
 * (`/feedback`, `/settings`) have their own steps (`*-redirect`).
 */
export interface Screen {
  step: string
  path: string
  adminOnly?: boolean
  needs?: 'project' | 'agent' | 'feedback' | 'workflow'
}

// pages/Settings/adminTabs.ts (7.59.00, main's tabs again): every tab and section (`/admin/<tab>[/<section>]`) and every
// card a link may name (`#<card>`), in the tabs' order. Workspaces (inside a workspace or a platform admin's) is
// workspace-admin.spec.ts's; Engineering agents shows only where the engineering module is on, so it is not a step.
// `/admin` and every 7.54.00 address are replaced by their new form, which screens.spec.ts checks (an admin lands on
// each location's own address).
const ADMIN_LOCATIONS = [
  'general', 'general#theme',
  'sources/plugins', 'sources/integrations', 'sources/inbox', 'sources/radar',
  'taxonomy/categories', 'taxonomy/dimensions',
  'access/policies', 'access/policies#erasure', 'access/users', 'access/boards', 'access/boards#domains', 'access/boards#participants',
  'ai',
  'system/logs', 'system/version',
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

/** `a/b` → `a-b`, `a` → `a`. */
const adminStep = (location: string): string => location.split(/[/#]/).join('-')

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
  ...PROJECT_TABS.map((tab): Screen => ({ step: `project-${tab}`, path: `/projects/{project}/${tab}`, needs: 'project' })),
  { step: 'prioritization', path: '/prioritization' },
  { step: 'data-explorer', path: '/data-explorer', adminOnly: true },
  { step: 'scrapers', path: '/scrapers' },
  { step: 'feedback-forms', path: '/feedback-forms' },
  ...PARTICIPANT_TABS.map((tab): Screen => ({ step: `participants-${tab}`, path: `/participants/${tab}` })),
  // Feedback boards (5.36): the board list, and the seeded Sales board every deployment has.
  { step: 'feature-requests', path: '/feature-requests' },
  { step: 'feature-board', path: '/feature-requests/sales-feature-requests' },
  ...MEMORY_TABS.map((tab): Screen => ({ step: `memory-${tab}`, path: `/memory/${tab}` })),
  ...COMPANY_TABS.map((tab): Screen => ({ step: `company-${tab}`, path: `/company/${tab}` })),
  { step: 'agents', path: '/agents' },
  // A non-admin has no library: `/agents/workflows` shows the agents view (not a redirect off the page).
  { step: 'agents-workflows', path: '/agents/workflows' },
  { step: 'workflow-page', path: '/agents/workflows/{workflow}', needs: 'workflow' },
  ...AGENT_TABS.map((tab): Screen => ({ step: `agent-${tab}`, path: `/agents/{agent}/${tab}`, needs: 'agent' })),
  { step: 'connect', path: '/connect' },
  ...ACCOUNT_TABS.map((tab): Screen => ({ step: `account-${tab}`, path: `/account/${tab}` })),
  { step: 'admin-home', path: '/admin', adminOnly: true },
  ...ADMIN_LOCATIONS.map((location): Screen => ({ step: `admin-${adminStep(location)}`, path: `/admin/${location}`, adminOnly: true })),
  { step: 'settings-redirect', path: '/settings', adminOnly: true },
  // Public pages (no session needed; the signed-in visit must not break them either).
  { step: 'unsubscribe', path: '/unsubscribe' },
  { step: 'board', path: '/board' },
  { step: 'board-slug', path: '/board/sales-feature-requests' },
  { step: 'board-login', path: '/board/login' },
  { step: 'not-found', path: '/e2e-no-such-page' },
]
