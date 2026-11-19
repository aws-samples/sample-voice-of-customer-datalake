/**
 * @fileoverview The application's pages, each loaded on first visit (`React.lazy`, one chunk per page).
 *
 * Kept apart from `routes.tsx` so that module exports only the route table and this one exports only
 * components: React Fast Refresh can hot-swap a module only when every export is a component
 * (`react-refresh/only-export-components`). Importing this module loads no page.
 *
 * @module lazyPages
 */
import { lazy } from 'react'

export const Home = lazy(() => import('./pages/Home/Home'))
export const Dashboard = lazy(() => import('./pages/Dashboard/Dashboard'))
export const FeedbackDetail = lazy(() => import('./pages/FeedbackDetail/FeedbackDetail'))
export const Categories = lazy(() => import('./pages/Categories/Categories'))
export const ProblemAnalysis = lazy(() => import('./pages/ProblemAnalysis/ProblemAnalysis'))
export const Settings = lazy(() => import('./pages/Settings/Settings'))
export const Scrapers = lazy(() => import('./pages/Scrapers/Scrapers'))
export const Chat = lazy(() => import('./pages/Chat/Chat'))
export const Projects = lazy(() => import('./pages/Projects/Projects'))
export const ProjectDetail = lazy(() => import('./pages/ProjectDetail/ProjectDetail'))
export const Prioritization = lazy(() => import('./pages/Prioritization/Prioritization'))
export const FeedbackForms = lazy(() => import('./pages/FeedbackForms/FeedbackForms'))
export const DataExplorer = lazy(() => import('./pages/DataExplorer/DataExplorer'))
export const Vote = lazy(() => import('./pages/Vote/Vote'))
export const Memory = lazy(() => import('./pages/Memory/Memory'))
export const Company = lazy(() => import('./pages/Company/Company'))
// Agent orchestration (7.52.00): the shell of its tabs and the tabs it draws itself, one chunk.
const orchestration = () => import('./pages/Agents/Agents')
export const Agents = lazy(orchestration)
export const AgentsAutomations = lazy(() => orchestration().then((m) => ({ default: m.AutomationsTab })))
export const AgentsRuns = lazy(() => orchestration().then((m) => ({ default: m.RunsTabPage })))
export const AgentsSpend = lazy(() => orchestration().then((m) => ({ default: m.SpendTab })))
export const AgentsFlows = lazy(() => orchestration().then((m) => ({ default: m.FlowsTab })))
export const AgentsConnections = lazy(() => orchestration().then((m) => ({ default: m.ConnectionsTab })))
export const AgentDetail = lazy(() => import('./pages/Agents/AgentDetail'))
export const SetupGuide = lazy(() => import('./pages/Agents/SetupGuide/SetupGuide'))
export const WorkflowPage = lazy(() => import('./pages/Agents/WorkflowPage'))
export const WorkflowTemplatePage = lazy(() => import('./pages/Agents/WorkflowTemplatePage'))
// An engineering run's monitor, by its run id (docs/autonomous-agents.md "An engineering run").
export const RunWorkspace = lazy(() => import('./pages/Agents/RunWorkspace/RunWorkspace'))
// Where GitHub sends an administrator back from creating and from installing the deployment's GitHub App (7.45.00).
export const GitHubAppCreated = lazy(() => import('./pages/Agents/GitHubAppCreated'))
export const GitHubAppInstalled = lazy(() => import('./pages/Agents/GitHubAppInstalled'))
export const GitHubAppAuthorized = lazy(() => import('./pages/Agents/GitHubAppAuthorized'))
export const Account = lazy(() => import('./pages/Account/Account'))
// The current workspace's members (docs/multi-workspace.md): a page only inside a workspace.
export const Members = lazy(() => import('./pages/Members/Members'))
// The current workspace's own settings (its brand and plugins): a page only inside a workspace.
export const WorkspaceSettings = lazy(() => import('./pages/WorkspaceSettings/WorkspaceSettings'))
export const Connect = lazy(() => import('./pages/Connect/Connect'))
// MCP OAuth consent (docs/mcp.md): where an assistant's sign-in lands, behind ProtectedRoute.
export const OAuthConsent = lazy(() => import('./pages/OAuthConsent/OAuthConsent'))
export const Radar = lazy(() => import('./pages/Radar/Radar'))
export const Participants = lazy(() => import('./pages/Participants/Participants'))
export const FeatureRequests = lazy(() => import('./pages/FeatureRequests/FeatureRequests'))
export const FeatureBoardPage = lazy(() => import('./pages/FeatureRequests/BoardPage'))
export const Board = lazy(() => import('./pages/Board/Board'))
export const Unsubscribe = lazy(() => import('./pages/Unsubscribe/Unsubscribe'))
export const Review = lazy(() => import('./pages/Review/Review'))
