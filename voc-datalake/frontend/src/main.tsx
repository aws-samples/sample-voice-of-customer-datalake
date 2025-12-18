import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Feedback from './pages/Feedback'
import FeedbackDetail from './pages/FeedbackDetail'
import Categories from './pages/Categories'
import ProblemAnalysis from './pages/ProblemAnalysis'
import Settings from './pages/Settings'
import Scrapers from './pages/Scrapers'
import Chat from './pages/Chat'
import Projects from './pages/Projects'
import ProjectDetail from './pages/ProjectDetail'
import Prioritization from './pages/Prioritization'
import FeedbackForms from './pages/FeedbackForms'
import './index.css'

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
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'feedback', element: <Feedback /> },
      { path: 'feedback/:id', element: <FeedbackDetail /> },
      { path: 'categories', element: <Categories /> },
      { path: 'problems', element: <ProblemAnalysis /> },
      { path: 'chat', element: <Chat /> },
      { path: 'projects', element: <Projects /> },
      { path: 'projects/:id', element: <ProjectDetail /> },
      { path: 'prioritization', element: <Prioritization /> },
      { path: 'scrapers', element: <Scrapers /> },
      { path: 'feedback-forms', element: <FeedbackForms /> },
      { path: 'settings', element: <Settings /> },
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
