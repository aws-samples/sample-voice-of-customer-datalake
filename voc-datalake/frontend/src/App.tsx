import { useEffect, useState } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import PageLoader from './components/PageLoader'
import { routes } from './routes'
import { loadRuntimeConfig, isConfigLoaded } from './runtimeConfig'
import { useConfigStore } from './store/configStore'
import { configureAmplify } from './lib/amplify-config'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 1,
    },
  },
})

const router = createBrowserRouter(routes)

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
