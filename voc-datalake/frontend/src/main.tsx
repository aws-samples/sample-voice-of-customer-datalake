import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Layout from './components/Layout'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'
import './index.css'

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

// Loading fallback component
const PageLoader = () => (
  <div className="flex items-center justify-center h-64">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
  </div>
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
})

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
      { index: true, element: <Suspense fallback={<PageLoader />}><Dashboard /></Suspense> },
      { path: 'feedback', element: <Suspense fallback={<PageLoader />}><Feedback /></Suspense> },
      { path: 'feedback/:id', element: <Suspense fallback={<PageLoader />}><FeedbackDetail /></Suspense> },
      { path: 'categories', element: <Suspense fallback={<PageLoader />}><Categories /></Suspense> },
      { path: 'problems', element: <Suspense fallback={<PageLoader />}><ProblemAnalysis /></Suspense> },
      { path: 'chat', element: <Suspense fallback={<PageLoader />}><Chat /></Suspense> },
      { path: 'projects', element: <Suspense fallback={<PageLoader />}><Projects /></Suspense> },
      { path: 'projects/:id', element: <Suspense fallback={<PageLoader />}><ProjectDetail /></Suspense> },
      { path: 'prioritization', element: <Suspense fallback={<PageLoader />}><Prioritization /></Suspense> },
      { path: 'scrapers', element: <Suspense fallback={<PageLoader />}><Scrapers /></Suspense> },
      { path: 'feedback-forms', element: <Suspense fallback={<PageLoader />}><FeedbackForms /></Suspense> },
      { path: 'settings', element: <Suspense fallback={<PageLoader />}><Settings /></Suspense> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
