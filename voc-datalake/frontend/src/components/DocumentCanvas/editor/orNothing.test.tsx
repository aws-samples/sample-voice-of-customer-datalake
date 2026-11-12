/** orNothing: a lazy canvas part whose chunk fails to load renders nothing; one that loads renders as itself. */
import { render, screen } from '@testing-library/react'
import { lazy, Suspense } from 'react'
import { describe, expect, it } from 'vitest'
import { orNothing } from './orNothing'

const Part = ({ label }: { readonly label: string }) => <p>{label}</p>

describe('orNothing', () => {
  it('gives the loaded component', async () => {
    const Loaded = lazy(() => orNothing(() => Promise.resolve({ default: Part })))
    render(<Suspense fallback={null}><p>text</p><Loaded label="menus" /></Suspense>)
    expect(await screen.findByText('menus')).toBeInTheDocument()
  })

  it('renders nothing, and leaves the rest standing, when the chunk cannot load', async () => {
    const Failed = lazy(() => orNothing<{ label: string }>(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module'))))
    const { container } = render(<div><p>text</p><Suspense fallback={null}><Failed label="menus" /></Suspense></div>)
    await screen.findByText('text')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(screen.queryByText('menus')).toBeNull()
    expect(container.textContent).toBe('text')
  })
})
