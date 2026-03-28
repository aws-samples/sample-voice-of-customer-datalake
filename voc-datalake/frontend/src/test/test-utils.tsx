/**
 * @fileoverview Test utilities for the VoC frontend.
 */
import { ReactNode } from 'react'
import { MemoryRouter, MemoryRouterProps } from 'react-router-dom'

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
