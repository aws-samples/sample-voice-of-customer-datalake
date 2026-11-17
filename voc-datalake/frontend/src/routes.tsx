/**
 * @fileoverview The application's route table.
 *
 * Split from App.tsx so the table can be imported without constructing a router:
 * `createBrowserRouter` runs at App.tsx's module scope, and the breadcrumb tests
 * need the routes, not a router. Importing this module has no side effects — the
 * pages come lazy from `lazyPages.ts` and nothing here runs at load.
 *
 * Every in-app place is a PATH (7.49.00, docs/document-canvas.md → "Addresses"): a page's tab, section,
 * open item, sub-view and mode are path segments its page reads itself (each area's `*Paths.ts`), and
 * only filters and search stay in the query. A route ending in `/*` is such a page: its splat is its
 * own places; an unknown place is replaced by the page's first one (no history entry, query kept). No
 * query link of before (`?tab=`, `&section=`, `&doc=`, `&view=`) is read or redirected: a pre-release change.
 * `locationParams.test.ts` holds every query read in the app to the filter / external-callback allowlist.
 *
 * Breadcrumbs' route tables are held to this one by `route coverage` in
 * Breadcrumbs.test.tsx: every layout route needs a label and every `:param` route
 * a stand-in, or the header falls back to printing a raw path segment. It reads
 * this table rather than a copy, because a copy would agree with itself forever
 * while the app grew routes past it.
 *
 * @module routes
 */
import { Suspense } from 'react'
import type { ReactNode } from 'react'
import type { RouteObject } from 'react-router-dom'
import FeedbackRedirect from './components/FeedbackRedirect'
import MovedRouteRedirect from './components/MovedRouteRedirect'
import Layout from './components/Layout/Layout'
import ProtectedRoute from './components/ProtectedRoute/ProtectedRoute'
import WorkspaceThemeSync from './theme/WorkspaceThemeSync'
import WorkspaceGate from './workspace/WorkspaceGate'
import AdminRoute from './components/AdminRoute/AdminRoute'
import PageLoader from './components/PageLoader/PageLoader'
import RouteErrorBoundary from './components/RouteErrorBoundary'
import NotFound from './components/RouteErrorBoundary/NotFound'
import Login from './pages/Login/Login'
import {
  Home, Dashboard, FeedbackDetail, Categories, ProblemAnalysis, Settings,
  Scrapers, Chat, Projects, ProjectDetail, Prioritization, FeedbackForms,
  DataExplorer, Vote, Memory, Company, Agents, AgentDetail, SetupGuide,
  WorkflowPage, WorkflowTemplatePage, RunWorkspace, GitHubAppCreated, GitHubAppInstalled, Account, Members, WorkspaceSettings, Connect, OAuthConsent,
  Radar, Participants,
  FeatureRequests, FeatureBoardPage, Board, Unsubscribe, Review,
} from './lazyPages'

// Lazy pages share the same suspense fallback and, per issue #173, a
// route-scoped error boundary: a render error in one page replaces only
// that page's content — the layout and sidebar stay mounted.
const page = (element: ReactNode) => ({
  element: <Suspense fallback={<PageLoader />}>{element}</Suspense>,
  errorElement: <RouteErrorBoundary />,
})

export const routes: RouteObject[] = [
  {
    // `/login`, and `/login/expired` when a session ended (services/sessionExpiry.ts).
    path: '/login/*',
    element: <Login />,
    errorElement: <RouteErrorBoundary />,
  },
  {
    /**
     * The anonymous ballot page, DELIBERATELY OUTSIDE `ProtectedRoute` (issue
     * #337).
     *
     * A room scores a proposal from their own phones with no account, so this is
     * the one page in the app besides `/login` that a signed-out visitor may
     * render. Its placement here — a sibling of `/login`, not a child of the
     * protected layout — is the whole of that decision, and
     * `routes.publicBallot.test.tsx` pins it so a later "tidy the routes into the
     * layout" cannot quietly take the feature down (or, worse, leave a copy of it
     * inside the protected tree that only signed-in users can reach).
     *
     * No `Layout` either: the sidebar and header are navigation for an
     * authenticated product, and a stranger holding a QR link has nothing to
     * navigate. The page renders its own full-height shell.
     *
     * The session token in `:sessionId` is what authorizes the write. It is
     * unguessable, the API checks it against a session that must be open and
     * unexpired and under its ballot cap, and closing the session revokes it —
     * being a public ROUTE grants nothing on its own.
     */
    path: '/vote/:sessionId',
    ...page(<Vote />),
  },
  {
    /**
     * The feedback boards for people who are NOT app users (docs/feature-requests.md), OUTSIDE
     * `ProtectedRoute` like `/vote`: `/board` (the boards this person may use), `/board/:slug` (one
     * board), `/board/:slug/:requestId` (a request open on it) and `/board/login[/:slug[/:requestId]]`,
     * routed inside the page. It has its own sign-in (a one-time code or
     * link emailed by the boards' own Cognito user pool, for the emails some board's audience admits)
     * and its own minimal shell. A board session grants only the board routes — the API's main
     * authorizer never accepts its tokens.
     */
    path: '/board/*',
    ...page(<Board />),
  },
  {
    /**
     * A PR/FAQ or PRD shared for review (docs/document-review.md), OUTSIDE `ProtectedRoute` like
     * `/board`: a reviewer signs in with the board pool's emailed code (an app user keeps their
     * session) and reads the newest version and comments. The API checks the link and the email.
     */
    path: '/review/:shareId',
    ...page(<Review />),
  },
  {
    /** One-click unsubscribe from participant emails (docs/participants.md): the emailed token is the control. */
    path: '/unsubscribe',
    ...page(<Unsubscribe />),
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        {/* Signed in: the caller's workspaces decide the picker, the not-found page or the app inside
            `/workspace/{slug}` (workspace/WorkspaceGate.tsx); with none, the app as before workspaces. */}
        <WorkspaceGate>
          {/* The administrator's start theme (GET /settings/appearance), read once signed in. */}
          <WorkspaceThemeSync />
          <Layout />
        </WorkspaceGate>
      </ProtectedRoute>
    ),
    // Catches errors thrown by Layout/ProtectedRoute themselves; page-level
    // errors are handled by each child's errorElement so the layout survives.
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, ...page(<Home />) },
      { path: 'dashboard', ...page(<Dashboard />) },
      { path: 'feedback', element: <FeedbackRedirect />, errorElement: <RouteErrorBoundary /> },
      { path: 'feedback/:id', ...page(<FeedbackDetail />) },
      { path: 'categories', ...page(<Categories />) },
      { path: 'problems', ...page(<ProblemAnalysis />) },
      { path: 'radar', ...page(<Radar />) },
      { path: 'chat', ...page(<Chat />) },
      { path: 'projects', ...page(<Projects />) },
      // A project: its tabs, a document, an older version and full screen are paths the page reads itself
      // (pages/ProjectDetail/projectPaths.ts: /projects/:id/documents/:docId/v/:n/focus).
      { path: 'projects/:id/*', ...page(<ProjectDetail />) },
      { path: 'prioritization', ...page(<Prioritization />) },
      // Its tab: /data-explorer/raw (/data-explorer too) or /data-explorer/processed (DataExplorer/dataExplorerPaths.ts).
      { path: 'data-explorer/*', ...page(<AdminRoute><DataExplorer /></AdminRoute>) },
      { path: 'scrapers', ...page(<Scrapers />) },
      { path: 'feedback-forms', ...page(<FeedbackForms />) },
      // Its tabs: /participants/lists|people|asks (Participants/participantsPaths.ts).
      { path: 'participants/*', ...page(<Participants />) },
      // Feedback boards (FeatureRequests/boardContext.ts): the list, its Insights tab, a request known only by its id
      // (looked up, then opened on its board), and one board by slug or id with a request open on it
      // (/feature-requests/:slug/:requestId). `insights` and `requests` are reserved slugs (feature_boards_store.py).
      { path: 'feature-requests', ...page(<FeatureRequests />) },
      { path: 'feature-requests/insights', ...page(<FeatureRequests />) },
      { path: 'feature-requests/requests/*', ...page(<FeatureRequests />) },
      { path: 'feature-requests/:slug/*', ...page(<FeatureBoardPage />) },
      // Their tabs: /memory/company|personal|review|imports, /company/vision|design|personas (memoryPaths.ts, companyPaths.ts).
      { path: 'memory/*', ...page(<Memory />) },
      { path: 'company/*', ...page(<Company />) },
      // The list's views are paths (Agents/agentsPaths.ts): /agents, /agents/workflows, /agents/spend,
      // /agents/connections, /agents/skills[/<role>[/v/<n>]], /agents/runs (7.51.00, the engineering runs, filtered by
      // `?month=&flow=&status=`). Each is listed, so it ranks above `agents/:id/*` (an agent's id is never a view's
      // name: `ag_<12 hex>`); the pages below with a longer static path rank above both.
      { path: 'agents', ...page(<Agents />) },
      { path: 'agents/runs/*', ...page(<Agents />) },
      { path: 'agents/workflows/*', ...page(<Agents />) },
      { path: 'agents/spend/*', ...page(<Agents />) },
      { path: 'agents/connections/*', ...page(<Agents />) },
      { path: 'agents/skills/*', ...page(<Agents />) },
      // The engineering setup guide and its steps: /agents/setup[/<step>] (Agents/SetupGuide/setupGuidePaths.ts).
      { path: 'agents/setup/*', ...page(<SetupGuide />) },
      // One agent and its tabs: /agents/<id>/<tab> (/agents/<id> is Settings).
      { path: 'agents/:id/*', ...page(<AgentDetail />) },
      // A library workflow on its own, outside any agent (Workflow library → Open / New workflow).
      { path: 'agents/workflows/:workflowId', ...page(<WorkflowPage />) },
      // A default engineering flow's unsaved copy (Workflow library → Start from a template), saved as a new workflow.
      { path: 'agents/workflows/templates/:templateId', ...page(<WorkflowTemplatePage />) },
      // An engineering run's workspace (7.51.00, Agents/RunWorkspace): the orchestrator's session, or one agent's open in
      // it (`/agents/engineering/<run>/a/<agent>`, RunWorkspace/runWorkspacePaths.ts). Listed in Agents → Runs.
      { path: 'agents/engineering/:runId/*', ...page(<RunWorkspace />) },
      // Where GitHub sends an administrator back from the deployment's GitHub App (Agents → Connections → Connect
      // GitHub): its creation (the manifest's redirect_url, with the code and the state) and its installation (the
      // App's setup_url). Both addresses are fixed in the manifest the server writes, so they must not move. Their
      // query is GitHub's (an external callback): each page takes it once and removes it from the address.
      { path: 'agents/connections/github/created', ...page(<GitHubAppCreated />) },
      { path: 'agents/connections/github/installed', ...page(<GitHubAppInstalled />) },
      { path: 'connect', ...page(<Connect />) },
      { path: 'oauth/authorize', ...page(<OAuthConsent />) },
      // Its tabs: /account/profile|preferences|briefing|objectives|access (Account/accountSections.ts).
      { path: 'account/*', ...page(<Account />) },
      // The current workspace's members (the header's workspace menu); "Page not found" outside a workspace.
      { path: 'members', ...page(<Members />) },
      // The current workspace's brand and plugins (the same menu), for every member; "Page not found" outside one.
      { path: 'workspace-settings', ...page(<WorkspaceSettings />) },
      // Administration (was Settings): admins only. Its tab, section and open board editor are paths
      // (/admin/access/boards/<boardId>, Settings/adminPaths.ts); the old /settings path redirects (to /admin).
      { path: 'admin/*', ...page(<AdminRoute><Settings /></AdminRoute>) },
      { path: 'settings', element: <MovedRouteRedirect to="/admin" />, errorElement: <RouteErrorBoundary /> },
      // Unknown URLs render a "Page not found" state INSIDE the layout, so the
      // sidebar stays usable. Without it React Router hands the 404 to the root
      // errorElement, which replaces the whole shell.
      { path: '*', element: <NotFound />, errorElement: <RouteErrorBoundary /> },
    ],
  },
]
