import {
  QueryClient, QueryClientProvider,
} from '@tanstack/react-query'
import {
  lazy, Suspense, useEffect, useState,
} from 'react'
import {
  createBrowserRouter, RouterProvider,
} from 'react-router-dom'
import AdminRoute from './components/AdminRoute'
import Layout from './components/Layout'
import PageLoader from './components/PageLoader'
import ProtectedRoute from './components/ProtectedRoute'
import { configureAmplify } from './lib/amplify-config'
import Login from './pages/Login'
import {
  loadRuntimeConfig, isConfigLoaded,
} from './runtimeConfig'
import { useConfigStore } from './store/configStore'

// Lazy load pages for better code splitting
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

/** Wrap a lazy-loaded component in Suspense with the standard PageLoader fallback. */
function LazyRoute({ component }: Readonly<{ component: React.LazyExoticComponent<() => React.JSX.Element> }>) {
  const Component = component
  return <Suspense fallback={<PageLoader />}><Component /></Suspense>
}

const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <Layout />
      </ProtectedRoute>
    ),
    children: [
      {
        index: true,
        element: <LazyRoute component={Dashboard} />,
      },
      {
        path: 'feedback',
        element: <LazyRoute component={Feedback} />,
      },
      {
        path: 'feedback/:id',
        element: <LazyRoute component={FeedbackDetail} />,
      },
      {
        path: 'categories',
        element: <LazyRoute component={Categories} />,
      },
      {
        path: 'problems',
        element: <LazyRoute component={ProblemAnalysis} />,
      },
      {
        path: 'chat',
        element: <LazyRoute component={Chat} />,
      },
      {
        path: 'projects',
        element: <LazyRoute component={Projects} />,
      },
      {
        path: 'projects/:id',
        element: <LazyRoute component={ProjectDetail} />,
      },
      {
        path: 'prioritization',
        element: <LazyRoute component={Prioritization} />,
      },
      {
        path: 'data-explorer',
        element: <LazyRoute component={DataExplorer} />,
      },
      {
        path: 'scrapers',
        element: <LazyRoute component={Scrapers} />,
      },
      {
        path: 'feedback-forms',
        element: <LazyRoute component={FeedbackForms} />,
      },
      {
        path: 'settings',
        element: <Suspense fallback={<PageLoader />}><AdminRoute><Settings /></AdminRoute></Suspense>,
      },
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
          return true
        })
        .catch((err) => {
          console.error('Failed to load config:', err)
          setError('Failed to load application configuration')
        })
    }
  }, [configReady, syncWithRuntimeConfig])

  if (error != null && error !== '') {
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
