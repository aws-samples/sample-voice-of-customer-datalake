/**
 * Review links inside the assistant: "Related feedback" cards, model-written `/feedback/<id>`
 * links and navigation chips open the review modal on the current page (it paints over the
 * full-screen assistant); a navigation chip or link to any other page is a real route change,
 * which drops full screen to the expanded panel so the page actually shows.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { NavigationChips, SourcesBlock } from './messageParts'
import { SafeLink } from './SafeLink'
import { shownMode, useAssistantUiStore } from '../store/assistantStore'
import type { ReactNode } from 'react'

function Location() {
  const location = useLocation()
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>
}

function renderAt(entry: string, ui: ReactNode) {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route path="*" element={<>{ui}<Location /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return userEvent.setup()
}

const location = () => screen.getByTestId('location').textContent
/** The mode the panel shows (wave 4: the stored mode stays full screen; the panel is uncovered). */
const mode = () => shownMode(useAssistantUiStore.getState())

beforeEach(() => {
  useAssistantUiStore.getState().setMode('fullscreen')
})

describe('assistant review links', () => {
  it('a Related feedback card opens the review modal on the current page', () => {
    renderAt('/chat', <SourcesBlock sources={{ feedback: [{ feedback_id: 'fb 1', text: 'Late parcel' }], web: [] }} />)
    expect(screen.getByRole('link', { name: /Late parcel/ })).toHaveAttribute('href', '/chat?review=fb+1')
  })

  it('a model-written /feedback/<id> link becomes a review link; other paths stay links', () => {
    renderAt('/dashboard', (
      <>
        <SafeLink href="/feedback/fb_7">the review</SafeLink>
        <SafeLink href="/projects/p1">the project</SafeLink>
      </>
    ))
    expect(screen.getByRole('link', { name: 'the review' })).toHaveAttribute('href', '/dashboard?review=fb_7')
    expect(screen.getByRole('link', { name: 'the project' })).toHaveAttribute('href', '/projects/p1')
  })

  it('a plain click on an in-app link leaves full screen', async () => {
    const user = renderAt('/chat', <SafeLink href="/projects/p1">the project</SafeLink>)
    await user.click(screen.getByRole('link', { name: 'the project' }))
    expect(location()).toBe('/projects/p1')
    expect(mode()).toBe('expanded')
  })
})

describe('NavigationChips', () => {
  it('a route chip navigates and drops full screen to expanded', async () => {
    const user = renderAt('/', <NavigationChips items={[{ path: '/problems', label: 'Problems' }]} />)
    await user.click(screen.getByRole('button', { name: 'Problems' }))
    expect(location()).toBe('/problems')
    expect(mode()).toBe('expanded')
  })

  it('a review chip opens the modal over the conversation and keeps full screen', async () => {
    const user = renderAt('/chat', <NavigationChips items={[{ path: '/feedback/fb_3', label: 'That review' }]} />)
    await user.click(screen.getByRole('button', { name: 'That review' }))
    await waitFor(() => { expect(location()).toBe('/chat?review=fb_3') })
    expect(mode()).toBe('fullscreen')
  })
})
