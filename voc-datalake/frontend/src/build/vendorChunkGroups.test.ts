/**
 * vendorChunkGroups (vite.config.ts `codeSplitting.groups`): every vendorChunks.json entry becomes a
 * first-load group claimed before its lazy twin, and a group matches only its own packages' folders.
 */
import { describe, expect, it } from 'vitest'
import VENDOR_CHUNKS from '../../vendorChunks.json' with { type: 'json' }
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

  it('gives a folder named inside a package to its own entry only, in both tiers', () => {
    const groups = vendorChunkGroups({ 'vendor-editor': ['@tiptap/react', 'react-dom'], 'vendor-editor-menus': ['@tiptap/react/dist/menus', 'react-dom/server'] })
    const claim = (moduleId: string) => groups.filter((g) => g.test(moduleId)).map((g) => `${g.name}:${String(g.priority)}`)

    expect(claim('/app/node_modules/@tiptap/react/dist/menus/index.js')).toStrictEqual(['vendor-editor-menus:1', 'vendor-editor-menus:0'])
    expect(claim('/app/node_modules/@tiptap/react/dist/index.js')).toStrictEqual(['vendor-editor:1', 'vendor-editor:0'])
    expect(claim('/app/node_modules/react-dom/server.js')).toStrictEqual(['vendor-editor:1', 'vendor-editor:0'])
    expect(claim('/app/node_modules/react-dom/server/index.js')).toStrictEqual(['vendor-editor-menus:1', 'vendor-editor-menus:0'])
  })
})

describe('the editor chunks (vendorChunks.json)', () => {
  const groups = vendorChunkGroups(VENDOR_CHUNKS)
  const chunkOf = (moduleId: string) => groups.find((g) => g.test(moduleId))?.name

  it.each<[moduleId: string, chunk: string]>([
    // What the text needs: the editor core and the schema's extensions.
    ['/app/node_modules/@tiptap/core/dist/index.js', 'vendor-editor'],
    ['/app/node_modules/@tiptap/react/dist/index.js', 'vendor-editor'],
    ['/app/node_modules/@tiptap/extension-table/dist/index.js', 'vendor-editor'],
    // What loads after it (editor/CanvasChrome.tsx): the format bar's menus, the block handle, their positioning.
    ['/app/node_modules/@tiptap/react/dist/menus/index.js', 'vendor-editor-menus'],
    ['/app/node_modules/@tiptap/extension-bubble-menu/dist/index.js', 'vendor-editor-menus'],
    ['/app/node_modules/@floating-ui/dom/dist/floating-ui.dom.mjs', 'vendor-editor-menus'],
    ['/app/node_modules/@tiptap/extension-drag-handle/dist/index.js', 'vendor-editor-menus'],
    ['/app/node_modules/@tiptap/extension-drag-handle-react/dist/index.js', 'vendor-editor-menus'],
  ])('puts %s in %s', (moduleId, chunk) => {
    expect(chunkOf(moduleId)).toBe(chunk)
  })

  it('lists the editor core before its menus, so the menus never capture it as a dependency', () => {
    const names = Object.keys(VENDOR_CHUNKS)
    expect(names.indexOf('vendor-editor')).toBeLessThan(names.indexOf('vendor-editor-menus'))
  })
})
