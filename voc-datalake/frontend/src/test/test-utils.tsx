/**
 * @fileoverview Test utilities for the VoC frontend.
 */
import type { ReactNode } from 'react'
import { MemoryRouter, type MemoryRouterProps } from 'react-router-dom'

interface TestRouterProps extends MemoryRouterProps {
  children: ReactNode
}

/**
 * TestRouter wrapping MemoryRouter for tests.
 * Always use this instead of MemoryRouter directly in tests.
 */
export function TestRouter({ children, ...props }: TestRouterProps) {
  return (
    <MemoryRouter {...props}>
      {children}
    </MemoryRouter>
  )
}
