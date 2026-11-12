/**
 * @fileoverview Run the app's sign-out (hooks/useSignOut.ts) once, in a fresh query client, for the suites that
 * check what a sign-out leaves behind or tells the other tabs.
 */
import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { useSignOut } from '../hooks/useSignOut'
import { createTestQueryClient } from './query-client'

/** Sign out as the sidebar's Sign out does. */
export function runSignOut(): void {
  const client = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  const { result } = renderHook(() => useSignOut(), { wrapper })
  act(() => result.current())
}
