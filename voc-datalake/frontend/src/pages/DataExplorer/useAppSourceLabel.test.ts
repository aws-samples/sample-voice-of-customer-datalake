/**
 * Wave 4 live finding: Data Explorer's source picker listed "com.acme.dreamhouse (Android)"
 * — an app stored under its package id — although the app config knows its name.
 */
import { describe, it, expect } from 'vitest'
import { appNamesByStoreId, appSourceName } from './useAppSourceLabel'

const names = appNamesByStoreId([
  { platform: 'Android', idField: 'package_name', apps: [
    { app_name: 'Acme Dreamhouse', package_name: 'com.acme.dreamhouse' },
    { app_name: 'Example Air', package_name: 'com.exampleair.app' },
  ] },
  { platform: 'iOS', idField: 'app_id', apps: [{ app_name: '', app_id: '123456789' }] },
])

describe('appSourceName', () => {
  it('names an app stored under its package id by the configured app name', () => {
    expect(appSourceName('com.acme.dreamhouse_Android', names)).toBe('Acme Dreamhouse (Android)')
  })

  it('leaves sources it does not know to the ordinary label', () => {
    expect([appSourceName('Example Air_Android', names), appSourceName('123456789_iOS', names), appSourceName('trustpilot', names)])
      .toStrictEqual([undefined, undefined, undefined])
  })
})
