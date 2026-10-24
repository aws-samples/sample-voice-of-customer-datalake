/**
 * Live finding: at 390 px the project tab bar hid its last tabs with no sign they
 * existed. A fade now marks each edge with more tabs past it, and clears once the
 * user has scrolled to that end. jsdom has no layout, so the widths are set by hand.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ProjectTabs from './ProjectTabs'

function setWidths(el: HTMLElement, { client, scroll, left }: { client: number; scroll: number; left: number }) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: client })
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll })
  Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: left })
}

describe('ProjectTabs scroll affordance', () => {
  it('fades the edge that hides tabs, and only that edge', () => {
    render(<ProjectTabs activeTab="overview" personasCount={0} documentsCount={0} onTabChange={vi.fn()} />)
    const track = screen.getByRole('tablist')
    setWidths(track, { client: 340, scroll: 620, left: 0 })
    fireEvent.scroll(track)
    expect(screen.getByTestId('tabs-fade-end')).toBeInTheDocument()
    expect(screen.queryByTestId('tabs-fade-start')).not.toBeInTheDocument()

    setWidths(track, { client: 340, scroll: 620, left: 280 })
    fireEvent.scroll(track)
    expect(screen.getByTestId('tabs-fade-start')).toBeInTheDocument()
    expect(screen.queryByTestId('tabs-fade-end')).not.toBeInTheDocument()
  })

  it('shows no fade when every tab fits', () => {
    render(<ProjectTabs activeTab="overview" personasCount={0} documentsCount={0} onTabChange={vi.fn()} />)
    const track = screen.getByRole('tablist')
    setWidths(track, { client: 900, scroll: 900, left: 0 })
    fireEvent.scroll(track)
    expect(screen.queryByTestId('tabs-fade-end')).not.toBeInTheDocument()
  })
})
