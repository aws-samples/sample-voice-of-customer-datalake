/**
 * Where the Data Explorer offers a write, as lambda/api/data_explorer_handler.py takes it: in a workspace only under
 * `raw/` (every other prefix is a 400 read-only); in the deployment anywhere but its read-only prefixes
 * (`_reject_read_only_prefix`: prototypes/, silver/, engineering/). An existing `raw/` object is never overwritten.
 */
import { describe, it, expect } from 'vitest'
import { canEditExisting, explorerAccess, explorerPlace, isWritableKey, newFilePrefix } from './writablePlace'

describe('explorerPlace', () => {
  it('is the workspace inside one, else the deployment', () => {
    expect(explorerPlace({ id: 'ws_acme' })).toBe('workspace')
    expect(explorerPlace(null)).toBe('deployment')
  })
})

describe('explorerAccess', () => {
  const WS = { id: 'ws_acme' }
  it("is refused in a workspace whose server role is not admin, open for its admins and outside every workspace", () => {
    expect(explorerAccess(WS, 'editor')).toBe('refused')
    expect(explorerAccess(WS, 'viewer')).toBe('refused')
    expect(explorerAccess(WS, 'admin')).toBe('open')
    expect(explorerAccess(null, null)).toBe('open')
  })

  it('is pending in a workspace until the server says the role it applies there', () => {
    expect(explorerAccess(WS, null)).toBe('pending')
  })
})

describe('isWritableKey', () => {
  it.each([
    ['raw/a.json', true],
    ['raw/reviews/a.json', true],
    ['exports/a.json', false],
    ['library/a.json', false],
    ['silver/a.json', false],
    ['a.json', false],
  ])('in a workspace, %s → %s', (key, writable) => {
    expect(isWritableKey(key, 'workspace')).toBe(writable)
  })

  it.each([
    ['raw/a.json', true],
    ['exports/a.json', true],
    ['prototypes/p1/index.html', false],
    ['silver/fb-1/1.json', false],
    ['engineering/cache/x.json', false],
  ])('in the deployment, %s → %s', (key, writable) => {
    expect(isWritableKey(key, 'deployment')).toBe(writable)
  })
})

describe('canEditExisting', () => {
  it('never offers to overwrite a raw object, in either place', () => {
    expect(canEditExisting('raw/a.json', 'workspace')).toBe(false)
    expect(canEditExisting('raw/a.json', 'deployment')).toBe(false)
  })

  it('offers an edit in the deployment outside raw/ and its read-only prefixes only', () => {
    expect(canEditExisting('exports/a.json', 'deployment')).toBe(true)
    expect(canEditExisting('silver/a.json', 'deployment')).toBe(false)
    expect(canEditExisting('prototypes/a.json', 'deployment')).toBe(false)
    expect(canEditExisting('engineering/a.json', 'deployment')).toBe(false)
  })

  it('offers no edit at all in a workspace (only raw/ is written there, and raw/ is write-once)', () => {
    expect(canEditExisting('exports/a.json', 'workspace')).toBe(false)
    expect(canEditExisting('library/a.json', 'workspace')).toBe(false)
  })
})

describe('newFilePrefix', () => {
  it.each([
    [[], 'workspace', 'raw/'],
    [['raw', 'reviews'], 'workspace', 'raw/reviews/'],
    [['exports'], 'workspace', 'raw/'],
    [['silver', 'fb-1'], 'workspace', 'raw/'],
    [[], 'deployment', 'raw/'],
    [['exports'], 'deployment', 'exports/'],
    [['silver'], 'deployment', 'raw/'],
    [['prototypes', 'p1'], 'deployment', 'raw/'],
  ] as const)('the folder %j in the %s → %s', (path, place, prefix) => {
    expect(newFilePrefix(path, place)).toBe(prefix)
  })
})
