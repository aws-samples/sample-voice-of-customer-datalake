/**
 * The workspace in the address: only a slug the platform could have made (platform_workspaces.py `_SLUG`,
 * `RESERVED_SLUGS`) becomes the router's base path; any other `/w/…` is a workspace nobody can be in.
 */
import { describe, expect, it, vi } from 'vitest'
import { appPathname, isWorkspaceSlug, PAGE_BASENAME, pageHref, parseWorkspacePath, SLUG_MAX_LENGTH, workspaceUrl } from './workspacePath'

describe('isWorkspaceSlug', () => {
  it('takes slugs up to SLUG_MAX_LENGTH characters, the create form\'s limit, and no longer', () => {
    expect([isWorkspaceSlug('a'.repeat(SLUG_MAX_LENGTH)), isWorkspaceSlug('a'.repeat(SLUG_MAX_LENGTH + 1))]).toStrictEqual([true, false])
  })

  it.each(['acme', 'juniper', 'a1b', 'team-2', 'x'.repeat(40)])('accepts %s', (slug) => {
    expect(isWorkspaceSlug(slug)).toBe(true)
  })

  it.each(['ab', 'x'.repeat(41), '-acme', 'acme-', 'Acme', 'ac_me', 'ac.me', 'ac%20me', 'admin', 'api', 'app', 'platform', 'www', ''])(
    'refuses %j',
    (slug) => {
      expect(isWorkspaceSlug(slug)).toBe(false)
    },
  )
})

describe('parseWorkspacePath', () => {
  it.each<[string, ReturnType<typeof parseWorkspacePath>]>([
    ['/w/acme', { kind: 'slug', slug: 'acme' }],
    ['/w/acme/', { kind: 'slug', slug: 'acme' }],
    ['/w/acme/projects/p1', { kind: 'slug', slug: 'acme' }],
    ['/', { kind: 'none' }],
    ['/dashboard', { kind: 'none' }],
    ['/wiki/acme', { kind: 'none' }],
    ['/w', { kind: 'none' }],
    ['/w/', { kind: 'invalid' }],
    ['/w/Acme/dashboard', { kind: 'invalid' }],
    ['/w/admin', { kind: 'invalid' }],
    ['/w/ac%2Fme/x', { kind: 'invalid' }],
  ])('reads %s', (pathname, expected) => {
    expect(parseWorkspacePath(pathname)).toStrictEqual(expected)
  })
})

/** The module as a page load of `pathname` reads it (its base path is fixed at load). */
async function loadedAt(pathname: string): Promise<typeof import('./workspacePath')> {
  vi.resetModules()
  // Restored after every test by setup.ts.
  Object.defineProperty(window, 'location', {
    value: { origin: window.location.origin, href: `${window.location.origin}${pathname}`, pathname }, writable: true, configurable: true,
  })
  return import('./workspacePath')
}

describe('the base path of a page load', () => {
  it('is /w/{slug} inside a workspace, so plain hrefs and the expired-session redirect keep it', async () => {
    const loaded = await loadedAt('/w/acme/dashboard')
    expect(loaded.PAGE_BASENAME).toBe('/w/acme')
    expect(loaded.pageHref('/login?expired=1')).toBe('/w/acme/login?expired=1')
    expect(loaded.appPathname('/w/acme/chat')).toBe('/chat')
  })

  it.each(['/w/ADMIN/dashboard', '/dashboard'])('is none for %s', async (pathname) => {
    const loaded = await loadedAt(pathname)
    expect(loaded.PAGE_BASENAME).toBeUndefined()
    expect(loaded.pageHref('/login?expired=1')).toBe('/login?expired=1')
  })
})

describe('the base path', () => {
  it('builds an address inside a workspace', () => {
    expect(workspaceUrl('acme', '/dashboard')).toBe('/w/acme/dashboard')
    expect(workspaceUrl('acme', '/')).toBe('/w/acme/')
  })

  it('is none for this page load (jsdom opens on /), so a plain href is the app path', () => {
    expect(PAGE_BASENAME).toBeUndefined()
    expect(pageHref('/projects/p1')).toBe('/projects/p1')
  })
})

describe('appPathname', () => {
  it('drops the base path, so /chat is still /chat inside a workspace', () => {
    expect(appPathname('/w/acme/chat', '/w/acme')).toBe('/chat')
    expect(appPathname('/w/acme', '/w/acme')).toBe('/')
    expect(appPathname('/w/acme-two/chat', '/w/acme')).toBe('/w/acme-two/chat')
  })

  it('leaves the path alone outside a workspace', () => {
    expect(appPathname('/chat', PAGE_BASENAME)).toBe('/chat')
    expect(appPathname()).toBe(window.location.pathname)
  })
})
