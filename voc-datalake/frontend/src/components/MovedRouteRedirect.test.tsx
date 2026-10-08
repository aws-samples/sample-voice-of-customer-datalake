/** `/settings` keeps working after the rename to Administration (todofeatures §6.1). */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { TestRouter } from '@test/TestRouter'
import MovedRouteRedirect from './MovedRouteRedirect'
import { routes } from '../routes'

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</p>
}

describe('MovedRouteRedirect', () => {
  it('keeps the query string and hash (tab deep links survive)', () => {
    render(
      <TestRouter initialEntries={['/settings?tab=categories#top']}>
        <Routes>
          <Route path="/settings" element={<MovedRouteRedirect to="/admin" />} />
          <Route path="/admin" element={<LocationProbe />} />
        </Routes>
      </TestRouter>,
    )
    expect(screen.getByTestId('location')).toHaveTextContent('/admin?tab=categories#top')
  })

  it('is what the route table mounts at /settings', () => {
    const children = routes.find((r) => r.path === '/')?.children ?? []
    const settings = children.find((r) => r.path === 'settings')
    expect(settings?.element).toStrictEqual(<MovedRouteRedirect to="/admin" />)
    expect(children.some((r) => r.path === 'admin')).toBe(true)
  })
})
