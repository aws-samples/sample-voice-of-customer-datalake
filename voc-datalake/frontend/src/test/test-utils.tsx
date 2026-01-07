/**
 * @fileoverview Test utilities and custom render function.
 * Provides wrapped render with all necessary providers.
 */
import { ReactNode } from 'react'
import { render, RenderOptions } from '@testing-library/react'
import { MemoryRouter, MemoryRouterProps } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Create a fresh QueryClient for each test with disabled retries.
 */
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

interface TestRouterProps extends MemoryRouterProps {
  children: ReactNode
}

/**
 * TestRouter with React Router v7 future flags.
 * Always use this instead of MemoryRouter directly in tests
 * to prevent deprecation warnings.
 */
export function TestRouter({ children, ...props }: TestRouterProps) {
  return (
    <MemoryRouter
      {...props}
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      {children}
    </MemoryRouter>
  )
}

interface AllProvidersProps {
  children: ReactNode
  initialEntries?: string[]
}

/**
 * Wrapper component with all providers needed for testing.
 */
function AllProviders({ children, initialEntries = ['/'] }: AllProvidersProps) {
  const queryClient = createTestQueryClient()
  return (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={initialEntries}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}


interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  initialEntries?: string[]
}

/**
 * Custom render function that wraps components with all providers.
 * Use this instead of @testing-library/react's render.
 * 
 * @example
 * ```tsx
 * import { render, screen } from '@test/test-utils'
 * 
 * render(<MyComponent />, { initialEntries: ['/dashboard'] })
 * expect(screen.getByText('Dashboard')).toBeInTheDocument()
 * ```
 */
function customRender(ui: React.ReactElement, options: CustomRenderOptions = {}) {
  const { initialEntries, ...renderOptions } = options
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders initialEntries={initialEntries}>{children}</AllProviders>
    ),
    ...renderOptions,
  })
}

// Re-export everything from testing-library
export * from '@testing-library/react'

// Override render with custom render
export { customRender as render }

// Export userEvent for interaction testing
export { default as userEvent } from '@testing-library/user-event'
