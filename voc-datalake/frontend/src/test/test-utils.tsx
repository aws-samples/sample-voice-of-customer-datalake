/**
 * @fileoverview Test utilities and custom render function.
 * Provides wrapped render with all necessary providers.
 */
import type { ReactElement } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import { AllProviders } from './TestRouter'

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  initialEntries?: string[]
}

/**
 * Custom render function that wraps components with all providers.
 * Use this instead of @testing-library/react's render.
 * 
 * @example
 * ```tsx
 * import { screen } from '@testing-library/react'
 * import { render } from '@test/test-utils'
 * 
 * render(<MyComponent />, { initialEntries: ['/dashboard'] })
 * expect(screen.getByText('Dashboard')).toBeInTheDocument()
 * ```
 */
function customRender(ui: ReactElement, options: CustomRenderOptions = {}) {
  const { initialEntries, ...renderOptions } = options
  return render(ui, {
    wrapper: ({ children }) => (
      <AllProviders initialEntries={initialEntries}>{children}</AllProviders>
    ),
    ...renderOptions,
  })
}

// Import everything else (screen, waitFor, ...) from @testing-library/react directly.
export { customRender as render }
