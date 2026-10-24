/**
 * @fileoverview The router every spec renders under, and the full provider
 * wrapper `render` from `test-utils` uses. Components only, so the file stays
 * fast-refresh clean (react-refresh/only-export-components).
 */
import type { ReactNode } from 'react'
import { MemoryRouter, type MemoryRouterProps } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from './query-client'

type TestRouterProps = Readonly<MemoryRouterProps & { children: ReactNode }>

/**
 * The router for specs. It used to pass the React Router v6 `v7_*` future
 * flags to silence deprecation warnings; on v7 those behaviours are the
 * defaults and the flags no longer exist, so this is a plain MemoryRouter kept
 * as the one place to configure every spec's router.
 */
export function TestRouter({ children, ...props }: TestRouterProps) {
  return <MemoryRouter {...props}>{children}</MemoryRouter>
}

type AllProvidersProps = Readonly<{
  children: ReactNode
  initialEntries?: string[]
}>

/**
 * Wrapper component with all providers needed for testing.
 */
export function AllProviders({ children, initialEntries = ['/'] }: AllProvidersProps) {
  const queryClient = createTestQueryClient()
  return (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={initialEntries}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}
