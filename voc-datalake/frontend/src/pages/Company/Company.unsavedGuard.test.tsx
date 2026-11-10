/**
 * @fileoverview The useDraft editors under the shared unsaved-changes guard,
 * in a DATA router, through the shared contract (3.00.00 R2): /company vision
 * & objectives, /company design system, and the caller's own objectives on
 * /account (MyContextSection). Each refetches a CHANGED server copy while the
 * dialog is open; Cancel must keep the draft and the next leave must ask again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { adminFlag, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import type { ReactElement } from 'react'
import type { GuardedEditorScenario } from '@test/unsavedGuardContract'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: CompanyContextSection } = await import('./CompanyContextSection')
const { default: DesignSystemSection } = await import('./DesignSystemSection')
const { default: MyContextSection } = await import('./MyContextSection')

const COMPANY = {
  vision: 'Be trusted',
  objectives: [{ id: 'o1', title: 'Halve late deliveries', description: '', horizon: 'quarter' }],
}
const DESIGN = {
  tokens: { colors: [], typography: [], spacing: [], radius: [] },
  guidelines: 'One primary action',
  references: [],
  integrations: { figma: false, github: false },
}

/**
 * The contract for one section mounted at `/page`: `serverPath` is its GET,
 * whose stored copy `changed` replaces while the dialog is open.
 */
function sectionScenario({ element, serverPath, stored, changed, ready, edit, expectDraft }: Readonly<{
  element: ReactElement
  serverPath: string
  stored: unknown
  changed: unknown
  ready: () => Promise<unknown>
  edit: GuardedEditorScenario['edit']
  expectDraft: () => void
}>): GuardedEditorScenario {
  const server = { current: stored }
  const client = createTestQueryClient()
  const mounted: { router?: ReturnType<typeof createMemoryRouter> } = {}
  return {
    mount: async () => {
      route({ [`GET ${serverPath}`]: () => server.current })
      mounted.router = createMemoryRouter(
        [
          { path: '/', element: <p>Home page</p> },
          { path: '/page', element: <><Link to="/">Home</Link>{element}</> },
        ],
        { initialEntries: ['/page'] },
      )
      renderWithQueryClient(<RouterProvider router={mounted.router} />, client)
      await ready()
    },
    edit,
    expectDraft,
    leave: async (user) => { await user.click(screen.getByRole('link', { name: 'Home' })) },
    expectStayed: () => expect(mounted.router?.state.location.pathname).toBe('/page'),
    expectLeft: async () => { expect(await screen.findByText('Home page')).toBeInTheDocument() },
    whileDialogOpen: async () => {
      server.current = changed
      // Resolves once the active section query has refetched the changed copy.
      await client.invalidateQueries()
    },
  }
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Cancel keeps the draft and stays guarded (R2 contract)', () => {
  it('/company vision & objectives', async () => {
    await expectCancelKeepsDraftGuarded(sectionScenario({
      element: <CompanyContextSection isAdmin />,
      serverPath: '/settings/company-context',
      stored: COMPANY,
      changed: { ...COMPANY, vision: 'Changed elsewhere' },
      ready: () => screen.findByRole('textbox', { name: 'Objective title' }),
      edit: async (user) => { await user.type(screen.getByRole('textbox', { name: 'Objective title' }), ' by June') },
      expectDraft: () => expect(screen.getByRole('textbox', { name: 'Objective title' })).toHaveValue('Halve late deliveries by June'),
    }))
  })

  it('/company design system', async () => {
    await expectCancelKeepsDraftGuarded(sectionScenario({
      element: <DesignSystemSection isAdmin />,
      serverPath: '/settings/design-system',
      stored: DESIGN,
      changed: { ...DESIGN, guidelines: 'Changed elsewhere' },
      ready: () => screen.findByLabelText('Guidelines'),
      edit: async (user) => { await user.type(screen.getByLabelText('Guidelines'), ' per screen') },
      expectDraft: () => expect(screen.getByLabelText('Guidelines')).toHaveValue('One primary action per screen'),
    }))
  })

  it('/account my objectives', async () => {
    await expectCancelKeepsDraftGuarded(sectionScenario({
      element: <MyContextSection />,
      serverPath: '/settings/my-context',
      stored: { objectives: [] },
      changed: { objectives: [{ id: 'p9', title: 'Theirs', description: '', kpis: [] }] },
      ready: () => screen.findByRole('button', { name: 'Add objective' }),
      edit: async (user) => {
        await user.click(screen.getByRole('button', { name: 'Add objective' }))
        await user.type(screen.getByRole('textbox', { name: 'Objective title' }), 'Mine')
      },
      expectDraft: () => expect(screen.getByRole('textbox', { name: 'Objective title' })).toHaveValue('Mine'),
    }))
  })
})
