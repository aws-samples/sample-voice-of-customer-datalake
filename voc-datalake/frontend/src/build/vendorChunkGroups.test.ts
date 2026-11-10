/**
 * vendorChunkGroups (vite.config.ts `codeSplitting.groups`): every vendorChunks.json entry becomes a
 * first-load group claimed before its lazy twin, and a group matches only its own packages' folders.
 */
import { describe, expect, it } from 'vitest'
import { vendorChunkGroups } from '../../vendorChunkGroups.ts'

const CHUNKS = { 'vendor-react': ['react', 'react-dom'], 'vendor-query': ['@tanstack/react-query'] }

describe('vendorChunkGroups', () => {
  it('returns the first-load groups (tagged $initial, priority 1) before the lazy ones, in entry order', () => {
    const groups = vendorChunkGroups(CHUNKS)

    expect(groups.map((g) => [g.name, g.priority, g.tags])).toStrictEqual([
      ['vendor-react', 1, ['$initial']],
      ['vendor-query', 1, ['$initial']],
      ['vendor-react', 0, undefined],
      ['vendor-query', 0, undefined],
    ])
  })

  it.each<[moduleId: string, expected: boolean]>([
    ['/app/node_modules/react/index.js', true],
    ['/app/node_modules/react-dom/server.js', true],
    ['C:\\app\\node_modules\\react\\index.js', true],
    ['/app/node_modules/react-router/dist/index.js', false],
    ['/app/src/react/index.ts', false],
  ])('matches %s in vendor-react: %s', (moduleId, expected) => {
    const [reactGroup] = vendorChunkGroups(CHUNKS)

    expect(reactGroup?.test(moduleId)).toBe(expected)
  })

  it('matches a scoped package by its full name', () => {
    const queryGroup = vendorChunkGroups(CHUNKS).find((g) => g.name === 'vendor-query')

    expect(queryGroup?.test('/app/node_modules/@tanstack/react-query/build/index.js')).toBe(true)
    expect(queryGroup?.test('/app/node_modules/@tanstack/query-core/build/index.js')).toBe(false)
  })

  it('returns no groups for an empty map', () => {
    expect(vendorChunkGroups({})).toStrictEqual([])
  })
})
