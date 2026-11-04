/**
 * The workspace start theme client: the wire paths and the lenient read (an unknown id = kiro).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { appearanceApi, appearanceKey, readAppearance } from './appearanceApi'

beforeEach(() => resetFetchApi())

describe('readAppearance', () => {
  it('reads a shipped theme id', () => {
    expect(readAppearance({ default_theme: 'nord' })).toStrictEqual({ default_theme: 'nord' })
  })

  it.each([[{ default_theme: 'solarized' }], [{}], [null], ['nope'], [undefined]])('reads %j as the default theme', (raw) => {
    expect(readAppearance(raw)).toStrictEqual({ default_theme: 'kiro' })
  })
})

describe('appearanceApi', () => {
  it('GETs /settings/appearance', async () => {
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: 'dracula' }) })
    await expect(appearanceApi.get()).resolves.toStrictEqual({ default_theme: 'dracula' })
  })

  it('PUTs the default theme and reads the saved settings', async () => {
    const handler = vi.fn((_body: unknown) => ({ success: true, settings: { default_theme: 'quick' } }))
    routeFetchApi({ 'PUT /settings/appearance': handler })
    await expect(appearanceApi.save('quick')).resolves.toStrictEqual({ default_theme: 'quick' })
    expect(handler).toHaveBeenCalledExactlyOnceWith({ default_theme: 'quick' })
  })

  it.each([[null], [{ success: true }], [{ settings: { default_theme: 'neon' } }]])(
    'keeps the requested theme when the 2xx answer %j does not echo a known id (never claims Kiro)',
    async (answer) => {
      routeFetchApi({ 'PUT /settings/appearance': () => answer })
      await expect(appearanceApi.save('nord')).resolves.toStrictEqual({ default_theme: 'nord' })
    },
  )

  it('rejects like the client when the server refuses', async () => {
    routeFetchApi({}, { missStatus: 403 })
    await expect(appearanceApi.save('nord')).rejects.toThrow('API Error: 403')
    expect(fetchApi).toHaveBeenCalledExactlyOnceWith('/settings/appearance', { method: 'PUT', body: '{"default_theme":"nord"}' })
  })

  it('keys the query under the config-family settings root', () => {
    expect(appearanceKey()).toStrictEqual(['settings', 'appearance'])
  })
})
