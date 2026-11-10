/**
 * @fileoverview Render-and-drive helpers for the `src/pages/Prioritization` page specs.
 *
 * This module imports the page, so it must be imported AFTER `./prioritization-fixtures`
 * in a spec: the `vi.mock` factories read that module, and the page's own imports are
 * what trigger them.
 */
import { expect } from 'vitest'
// Fixture files compile under the app tsconfig (test files and `src/test/setup.ts`
// are excluded from it), so the jest-dom matcher types must be brought in here for
// the `expect*` helpers below. The runtime registration this also performs is the
// same one `src/test/setup.ts` already did.
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UserEvent } from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, createMemoryRouter, RouterProvider } from 'react-router-dom'
import i18n from 'i18next'
import Prioritization from './Prioritization'
import { ROW_TITLE, escapeRegExp } from './prioritization-fixtures'
import { required } from '../../components/component-spec-fixtures'

const { t } = i18n

/**
 * Mount the page under a fresh, retry-free QueryClient and a memory router.
 *
 * Returns the client, for the cases that drive a refetch through
 * `queryClient.invalidateQueries(...)`.
 */
export function renderPrioritization(): QueryClient {
  return mountRoutes([{ path: '/', element: <Prioritization /> }]).queryClient
}

/** Mount `routes` (starting at `/`) under a fresh, retry-free QueryClient. */
function mountRoutes(routes: Parameters<typeof createMemoryRouter>[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(routes)
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { queryClient, router }
}

/**
 * {@link renderPrioritization} with a way out: a "Leave" link to `/elsewhere`,
 * for the shared unsaved-changes contract. Returns the client and the router.
 */
export function renderPrioritizationWithExit(): { queryClient: QueryClient; router: ReturnType<typeof createMemoryRouter> } {
  return mountRoutes([
    { path: '/', element: <><Link to="/elsewhere">Leave</Link><Prioritization /></> },
    { path: '/elsewhere', element: <p>Elsewhere page</p> },
  ])
}

/**
 * Render, wait for the row titled `title`, and click it open — the sliders, the
 * prototype panel and the room vote are all expand-only.
 */
export async function openRow(title: string = ROW_TITLE): Promise<UserEvent> {
  const user = userEvent.setup()
  await renderUntilRow(title)
  await user.click(screen.getByText(title))
  return user
}

/**
 * `openRow`, then the four axis sliders the expansion reveals — the list, plus the
 * first two by axis (impact, then time to market), which fail loudly when absent.
 */
export async function openRowSliders(title: string = ROW_TITLE) {
  const user = await openRow(title)
  const sliders = await screen.findAllByRole('slider')
  return {
    user,
    sliders,
    get impact(): HTMLElement { return required(sliders[0], 'the impact slider') },
    get timeToMarket(): HTMLElement { return required(sliders[1], 'the time-to-market slider') },
  }
}

/** The impact slider (the first axis) of the row currently open. */
export async function findImpactSlider(): Promise<HTMLElement> {
  return required((await screen.findAllByRole('slider')).at(0), 'the impact slider')
}

/** Render and wait until the row titled `title` is on screen, without opening it. */
export async function renderUntilRow(title: string = ROW_TITLE): Promise<QueryClient> {
  const queryClient = renderPrioritization()
  await waitFor(() => {
    expect(screen.getByText(title)).toBeInTheDocument()
  })
  return queryClient
}

/** Render and wait for the header button of the row whose title matches `title`. */
export async function renderUntilRowButton(title: RegExp = new RegExp(escapeRegExp(ROW_TITLE))): Promise<HTMLElement> {
  renderPrioritization()
  return screen.findByRole('button', { name: title })
}

/**
 * Render and, once the last row of `order` has landed, read the whole list order.
 *
 * Waits for the row the sort puts LAST — the one with no team score in the cases
 * that use this — so the order is read after every row is on screen.
 */
export async function expectRowOrderAfterLoad(order: readonly string[]): Promise<void> {
  await renderUntilRow(order[order.length - 1])
  expect(rowTitles()).toEqual(order)
}

/** The expansion itself has rendered: its scores panel is on screen. */
export async function expectScoresPanelShown(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText(t('prioritization:scores.title'))).toBeInTheDocument()
  })
}

/** Move the `index`-th axis slider of the open row to `value`. */
export async function moveSlider(index: number, value: string): Promise<void> {
  const slider = (await screen.findAllByRole('slider')).at(index)
  if (slider === undefined) throw new Error(`fixture: no slider at index ${index}`)
  fireEvent.change(slider, { target: { value } })
}

/** The row header button for the row whose title matches `title`. */
export function rowButton(title: RegExp): HTMLElement {
  return screen.getByRole('button', { name: title })
}

export function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: /save/i })
}

/** Save becomes enabled — an edit registered and the guard is not holding it. */
export async function expectSaveEnabled(): Promise<void> {
  await waitFor(() => {
    expect(saveButton()).toBeEnabled()
  })
}

/** Move one slider, wait for Save to arm, and press it. */
export async function moveSliderAndSave(user: UserEvent, slider: HTMLElement, value: string): Promise<void> {
  fireEvent.change(slider, { target: { value } })
  await expectSaveEnabled()
  await user.click(saveButton())
}

/**
 * The stats grid above the list, or `null` when it is not on screen.
 *
 * Scoped queries go through it because "High Priority" and "Not Scored" are also
 * the rows' own priority-band labels, so an unscoped query reads a row.
 */
export function statsGrid(): HTMLElement | null {
  return screen.getByText('Total Proposals').closest<HTMLElement>('div.grid')
}

/** The number printed above one stats card's label. */
export function cardValue(label: string): string | null | undefined {
  return within(statsGrid() ?? document.body).getByText(label).previousElementSibling?.textContent
}

/** The row titles in list order, without the page's own "Prioritization Framework" heading. */
export function rowTitles(): (string | null)[] {
  return screen.getAllByRole('heading', { level: 3 })
    .map((h) => h.textContent)
    .filter((title) => title !== 'Prioritization Framework')
}

/** Neither row copy that claims nobody has scored it: not the label, not the band. */
export function expectRowNotPresentedAsUnscored(row: HTMLElement) {
  expect(row).not.toHaveTextContent('Not scored yet')
  expect(row).not.toHaveTextContent('Not Scored')
}

/** Open the row and find the team panel inside its expansion. */
export async function expectTeamPanelOpened(): Promise<HTMLElement | null> {
  await openRow()

  const panel = (await screen.findByText('What the Team Said')).parentElement
  expect(panel).toBeTruthy()
  return panel
}

/**
 * Move a slider on the open row, and see the edit register — Reset appears with
 * `hasChanges` — while Save stays disabled: the guard's doing, not an absence of
 * anything to save.
 */
export async function expectEditHeldByTheGuard() {
  await moveSlider(0, '4')

  expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument()
  expect(saveButton()).toBeDisabled()
}

/** The scores panel says the sliders show defaults and asks for a reload before saving. */
export function expectScoresPanelSaysDefaults(): HTMLElement {
  const panel = screen.getByRole('alert', { name: 'Scores could not be loaded' })
  expect(panel).toHaveTextContent('are defaults')
  expect(panel).toHaveTextContent('Reload the page before saving')
  return panel
}
