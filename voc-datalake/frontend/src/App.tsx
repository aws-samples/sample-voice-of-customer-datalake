import { lazy, Suspense, useEffect, useState } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import AdminRoute from './components/AdminRoute'
import PageLoader from './components/PageLoader'
import RouteErrorBoundary from './components/RouteErrorBoundary'
import Login from './pages/Login'
import { loadRuntimeConfig, isConfigLoaded } from './runtimeConfig'
import { useConfigStore } from './store/configStore'
import { configureAmplify } from './lib/amplify-config'

// Lazy load pages for better code splitting
const Home = lazy(() => import('./pages/Home'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Feedback = lazy(() => import('./pages/Feedback'))
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
})

// Lazy pages share the same suspense fallback and, per issue #173, a
// route-scoped error boundary: a render error in one page replaces only
// that page's content — the layout and sidebar stay mounted.
const page = (element: React.ReactNode) => ({
  element: <Suspense fallback={<PageLoader />}>{element}</Suspense>,
  errorElement: <RouteErrorBoundary />,
})

const router = createBrowserRouter([
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
      { path: 'feedback', ...page(<Feedback />) },
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
])

/**
 * App wrapper that loads runtime config before rendering.
 */
export default function App() {
  const [configReady, setConfigReady] = useState(isConfigLoaded())
  const [error, setError] = useState<string | null>(null)
  const syncWithRuntimeConfig = useConfigStore((state) => state.syncWithRuntimeConfig)

  useEffect(() => {
    if (!configReady) {
      loadRuntimeConfig()
        .then(() => {
          // Sync the config store with runtime config to ensure
          // first-time users get the correct API endpoint
          syncWithRuntimeConfig()
          
          // Configure Amplify after runtime config is loaded
          configureAmplify()
          
          setConfigReady(true)
        })
        .catch((err) => {
          console.error('Failed to load config:', err)
          setError('Failed to load application configuration')
        })
    }
  }, [configReady, syncWithRuntimeConfig])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-red-600 mb-2">Configuration Error</h1>
          <p className="text-gray-600">{error}</p>
          <button 
            onClick={() => window.location.reload()} 
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!configReady) {
    return <PageLoader />
  }

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
