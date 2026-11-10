/**
 * The board's search / status / sort live in the URL. Two controls changed back to back
 * (clear the search, then pick a status — e2e feature-requests fr-03) must both stick: the
 * second change never writes the first one's stale value back. Under the app's data router
 * a search change used to commit in a transition, so the second event ran the handler of
 * the render before the first change.
 *
 * The clicks are native `click()` calls, outside `act`: React's own event path, without
 * act flushing the router's transition between them (which would hide the race).
 */
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom'
import { useBoardControls } from './useBoardControls'

function Probe() {
  const [controls, update] = useBoardControls()
  const location = useLocation()
  return (
    <>
      <output aria-label="controls">{JSON.stringify(controls)}</output>
      <output aria-label="search">{location.search}</output>
      <button type="button" onClick={() => update({ query: '' })}>Clear search</button>
      <button type="button" onClick={() => update({ status: 'new' })}>Status new</button>
      <button type="button" onClick={() => update({ sort: 'newest' })}>Sort newest</button>
    </>
  )
}

function setup(initial: string) {
  const router = createMemoryRouter([{ path: '/feature-requests', element: <Probe /> }], { initialEntries: [`/feature-requests${initial}`] })
  render(<RouterProvider router={router} />)
  const click = (name: string) => screen.getByRole('button', { name }).click()
  const shown = (label: string) => screen.getByLabelText(label).textContent
  return { click, shown }
}

describe('useBoardControls', () => {
  it('keeps a cleared search when the status changes right after', async () => {
    const { click, shown } = setup('?q=checkout&request=fr_1')
    click('Clear search')
    click('Status new')
    await waitFor(() => expect(shown('search')).toBe('?request=fr_1&status=new'))
    expect(JSON.parse(shown('controls'))).toStrictEqual({ query: '', status: 'new', sort: 'newest' })
  })

  // Any key-shaped status is kept (each board has its own statuses; RequestList drops one its board lacks).
  it('leaves defaults out of the URL and reads a malformed status as the default', async () => {
    const { click, shown } = setup('?status=Not-A-Key&sort=committed')
    expect(JSON.parse(shown('controls'))).toStrictEqual({ query: '', status: 'all', sort: 'committed' })
    click('Sort newest')
    await waitFor(() => expect(shown('search')).toBe('?status=Not-A-Key'))
  })
})
