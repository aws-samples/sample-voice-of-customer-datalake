/**
 * A request's copied link opens the same place: inside a workspace it carries the page's `/workspace/<slug>`, as a
 * review's copied link does (workspacePath.ts `pageHref`); outside one it is the board's own path.
 */
import { describe, expect, it, vi } from 'vitest'

const page = vi.hoisted(() => ({ basename: '' }))

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../workspace/workspacePath', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workspace/workspacePath')>(),
  pageHref: (path: string) => `${page.basename}${path}`,
}))

const { shareLinkFor } = await import('./boardContext')

describe('shareLinkFor', () => {
  it('carries the page\'s workspace, so the link opens the request in that workspace', () => {
    page.basename = '/workspace/acme'
    expect(shareLinkFor({ basePath: '/feature-requests' }, 'sales', 'fr_1', 'https://app.example.com'))
      .toBe('https://app.example.com/workspace/acme/feature-requests/sales/fr_1')
  })

  it('is the board\'s own path outside a workspace', () => {
    page.basename = ''
    expect(shareLinkFor({ basePath: '/board' }, 'sales', 'fr 1', 'https://app.example.com'))
      .toBe('https://app.example.com/board/sales/fr%201')
  })
})
