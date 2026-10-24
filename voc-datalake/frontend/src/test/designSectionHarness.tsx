/**
 * @fileoverview A harness for the /company → Design system specs: mount
 * `DesignSystemSection` (admin or not, per `adminFlag`) over routed `fetchApi`
 * answers, with the scroll stub its apply banner needs and a fresh admin
 * caller before every test.
 *
 * A spec wires `@test/fetchApiRoutes` in first (`vi.mock` of `api/client` and
 * `store/authStore`), then imports this module.
 */
import { afterAll, beforeAll, beforeEach } from 'vitest'
import DesignSystemSection from '../pages/Company/DesignSystemSection'
import { renderWithQueryClient } from './query-client'
import { TestRouter } from './TestRouter'
import { adminFlag, resetFetchApi, routeFetchApi } from './fetchApiRoutes'
import { stubElementScrollIntoView } from './stubScrollTo'
import type { RouteHandler } from './fetchApiRoutes'

/** Route `routes` (a GET /settings/design-system among them) and mount the section. */
export function renderDesignSection(routes: Record<string, RouteHandler>): void {
  routeFetchApi(routes)
  renderWithQueryClient(<TestRouter><DesignSystemSection isAdmin={adminFlag.isAdmin} /></TestRouter>)
}

/** Registers the suite's hooks: the scrollIntoView stub, and a reset admin caller per test. */
export function registerDesignSectionHooks(): void {
  const restore: { scroll?: () => void } = {}
  beforeAll(() => { restore.scroll = stubElementScrollIntoView() })
  afterAll(() => restore.scroll?.())
  beforeEach(() => {
    resetFetchApi()
    adminFlag.isAdmin = true
  })
}
