/**
 * Live finding (5.34.00 at 390 px): the project tab bar scrolled sideways with a hidden
 * scrollbar, so Documents, Decisions and Participants were out of reach for a mouse.
 * The bar now wraps: one tablist, every tab laid out in it, nothing to scroll. jsdom has
 * no layout, so this pins the wrapping class and the absence of the scroll machinery;
 * the 390 px check itself is a browser run (the e2e mobile suite).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ProjectTabs from './ProjectTabs'

describe('ProjectTabs at a narrow width', () => {
  it('is one wrapping tab bar, so every tab is reachable without scrolling sideways', () => {
    render(<ProjectTabs activeTab="participants" personasCount={3} documentsCount={6} onTabChange={vi.fn()} />)
    const lists = screen.getAllByRole('tablist')
    expect(lists).toHaveLength(1)
    expect(lists[0]).toHaveClass('flex-wrap')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toStrictEqual([
      'Overview', 'Personas(3)', 'Product', 'Documents(6)', 'Decisions', 'Participants',
    ])
  })

  it('draws no edge fade, which only made sense for a bar that hid tabs', () => {
    render(<ProjectTabs activeTab="overview" personasCount={0} documentsCount={0} onTabChange={vi.fn()} />)
    expect(screen.queryByTestId('tabs-fade-end')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tabs-fade-start')).not.toBeInTheDocument()
  })
})
