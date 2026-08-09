/**
 * @fileoverview The application's route table.
 *
 * Split from App.tsx so the table can be imported without constructing a router:
 * `createBrowserRouter` runs at App.tsx's module scope, and the breadcrumb tests
 * need the routes, not a router. Importing this module has no side effects — the
 * page imports are lazy and nothing here runs at load.
 *
 * Breadcrumbs' route tables are held to this one by `route coverage` in
 * Breadcrumbs.test.tsx: every layout route needs a label and every `:param` route
 * a stand-in, or the header falls back to printing a raw path segment. It reads
 * this table rather than a copy, because a copy would agree with itself forever
 * while the app grew routes past it.
 *
 * @module routes
 */
import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import type { RouteObject } from 'react-router-dom'
import FeedbackRedirect from './components/FeedbackRedirect'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import AdminRoute from './components/AdminRoute'
import PageLoader from './components/PageLoader'
import RouteErrorBoundary from './components/RouteErrorBoundary'
import Login from './pages/Login'

// Lazy load pages for better code splitting
const Home = lazy(() => import('./pages/Home'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const FeedbackDetail = lazy(() => import('./pages/FeedbackDetail'))
const Categories = lazy(() => import('./pages/Categories'))
const ProblemAnalysis = lazy(() => import('./pages/ProblemAnalysis'))
const Settings = lazy(() => import('./pages/Settings'))
const Scrapers = lazy(() => import('./pages/Scrapers'))
const Chat = lazy(() => import('./pages/Chat'))
const Projects = lazy(() => import('./pages/Projects'))
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'))
const Prioritization = lazy(() => import('./pages/Prioritization'))
const FeedbackForms = lazy(() => import('./pages/FeedbackForms'))
const DataExplorer = lazy(() => import('./pages/DataExplorer'))

// Lazy pages share the same suspense fallback and, per issue #173, a
// route-scoped error boundary: a render error in one page replaces only
// that page's content — the layout and sidebar stay mounted.
const page = (element: ReactNode) => ({
  element: <Suspense fallback={<PageLoader />}>{element}</Suspense>,
  errorElement: <RouteErrorBoundary />,
})

export const routes: RouteObject[] = [
  {
    path: '/login',
    element: <Login />,
    errorElement: <RouteErrorBoundary />,
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <Layout />
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
      { path: 'chat', ...page(<Chat />) },
      { path: 'projects', ...page(<Projects />) },
      { path: 'projects/:id', ...page(<ProjectDetail />) },
      { path: 'prioritization', ...page(<Prioritization />) },
      { path: 'data-explorer', ...page(<DataExplorer />) },
      { path: 'scrapers', ...page(<Scrapers />) },
      { path: 'feedback-forms', ...page(<FeedbackForms />) },
      { path: 'settings', ...page(<AdminRoute><Settings /></AdminRoute>) },
    ],
  },
]
