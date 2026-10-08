/**
 * @fileoverview TanStack Query test support: a no-retry QueryClient and the
 * provider wrappers specs mount components with.
 *
 * Every component spec that mounts a `useQuery` consumer used to build its own
 * `new QueryClient({ defaultOptions: { queries: { retry: false, … } } })` and
 * wrap the render by hand. Keeping the recipe here means the retry/gc defaults
 * cannot drift between suites.
 */
import type { ReactElement, ReactNode } from 'react'
import { render, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type DefaultOptions } from '@tanstack/react-query'

type QueryDefaults = NonNullable<DefaultOptions['queries']>

/**
 * A fresh QueryClient whose queries and mutations never retry and whose cache
 * is dropped as soon as a query has no observers (`gcTime: 0`). Pass extra
 * query defaults (e.g. `{ staleTime: 0 }`) when a spec needs them.
 */
export function createTestQueryClient(queries: QueryDefaults = {}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, ...queries },
      mutations: { retry: false },
    },
  })
}

/** A `wrapper` for `render`/`renderHook` that provides `client` (a new no-retry client by default). */
function createQueryWrapper(client: QueryClient = createTestQueryClient()) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

/** `render(ui)` inside a QueryClientProvider (a new no-retry client by default). */
export function renderWithQueryClient(
  ui: ReactElement,
  client: QueryClient = createTestQueryClient(),
): RenderResult {
  return render(ui, { wrapper: createQueryWrapper(client) })
}
