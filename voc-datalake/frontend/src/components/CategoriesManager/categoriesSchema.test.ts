/**
 * Regression tests for issue #181: legacy category rows ({name,
 * display_name, color} — no id, no subcategories) crashed the Settings
 * Categories tab with "Cannot read properties of undefined (reading
 * 'length')". normalizeCategories makes the declared Category contract
 * true at the query boundary WITHOUT dropping user config: ids are
 * derived from names, because the save flow round-trips the whole list
 * and a dropped row would be silently deleted on the next save.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeCategories, normalizeOwnerCandidates } from './categoriesSchema'
import { at } from '@test/defined'

const legacyRow = { name: 'app', display_name: 'Mobile App', description: 'App experience', color: '#EC4899' }

describe('normalizeCategories (issue #181)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives a legacy row a derived id and an empty subcategories array', () => {
    const category = at(normalizeCategories([legacyRow]), 0)

    expect(category.id).toBe('cat_app')
    expect(category.subcategories).toStrictEqual([])
    expect(category.name).toBe('app')
  })

  it('passes legacy fields through so a save round-trip loses nothing', () => {
    const category = at(normalizeCategories([legacyRow]), 0)

    expect(category).toMatchObject({ display_name: 'Mobile App', color: '#EC4899' })
  })

  it('keeps a complete row unchanged', () => {
    const complete = {
      id: 'cat_delivery',
      name: 'delivery',
      description: 'Shipping issues',
      subcategories: [{ id: 'sub_late', name: 'late_delivery', description: 'Late' }],
    }

    expect(normalizeCategories([complete])).toStrictEqual([complete])
  })

  it('treats explicit null subcategories like missing (DynamoDB emits both)', () => {
    const category = at(normalizeCategories([{ ...legacyRow, subcategories: null }]), 0)

    expect(category.subcategories).toStrictEqual([])
  })

  it('salvages valid subcategory items, deriving missing sub ids', () => {
    const category = at(normalizeCategories([{
      id: 'cat_x', name: 'x',
      subcategories: [
        { name: 'late delivery' },
        'junk-string',
        { id: 'sub_ok', name: 'ok' },
      ],
    }]), 0)

    expect(category.subcategories).toStrictEqual([
      { id: 'sub_late_delivery', name: 'late delivery' },
      { id: 'sub_ok', name: 'ok' },
    ])
  })

  it('derives ids deterministically so repeated loads agree', () => {
    const first = normalizeCategories([legacyRow])
    const second = normalizeCategories([legacyRow])

    expect(at(first, 0).id).toBe(at(second, 0).id)
  })

  it('de-duplicates colliding derived ids so row actions cannot cross-target', () => {
    const categories = normalizeCategories([
      { name: 'App' },
      { name: 'app' },
      { name: 'app  ' },
    ])

    expect(categories.map((c) => c.id)).toStrictEqual(['cat_app', 'cat_app_2', 'cat_app_3'])
  })

  it('de-duplicates a derived id against a stored one', () => {
    const categories = normalizeCategories([
      { id: 'cat_app', name: 'application', subcategories: [] },
      { name: 'app' },
    ])

    expect(categories.map((c) => c.id)).toStrictEqual(['cat_app', 'cat_app_2'])
  })

  it('never rewrites a stored id, regardless of list order', () => {
    // The save flow round-trips wholesale: if the derived row (listed FIRST)
    // claimed cat_app, the stored identity would be silently rewritten and
    // persisted on the next save.
    const categories = normalizeCategories([
      { name: 'app' },
      { id: 'cat_app', name: 'application', subcategories: [] },
    ])

    expect(categories.map((c) => c.id)).toStrictEqual(['cat_app_2', 'cat_app'])
  })

  it('sanitizes non-alphanumerics in derived ids', () => {
    const category = at(normalizeCategories([{ name: 'billing/refunds & credits' }]), 0)

    expect(category.id).toBe('cat_billing_refunds_credits')
  })

  it('treats whitespace-only and symbol-only names as unusable identity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const categories = normalizeCategories([legacyRow, { name: '   ' }, { name: '///' }])

    expect(categories.map((c) => c.id)).toStrictEqual(['cat_app'])
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('drops a row only when both id and name are unusable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const categories = normalizeCategories([
      legacyRow,
      { description: 'nothing to key on' },
      { id: '', name: '' },
    ])

    expect(categories.map((c) => c.id)).toStrictEqual(['cat_app'])
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('category product and owners (contract C)', () => {
  it('keeps product and well-formed owners', () => {
    const category = at(normalizeCategories([{
      id: 'cat_a', name: 'a', product: 'Checkout',
      owners: [{ sub: 's1', username: 'ada', email: 'ada@example.com' }],
      subcategories: [],
    }]), 0)
    expect(category.product).toBe('Checkout')
    expect(category.owners).toStrictEqual([{ sub: 's1', username: 'ada', email: 'ada@example.com' }])
  })

  it('drops an owner without a usable sub (it could not grant anything)', () => {
    const category = at(normalizeCategories([{ id: 'cat_a', name: 'a', owners: [{ username: 'x' }, { sub: ' ', username: 'y' }, { sub: 's2' }] }]), 0)
    expect(category.owners).toStrictEqual([{ sub: 's2', username: '', email: '' }])
  })

  it('accepts the non-admin GET shape (owners reduced to usernames) without dropping the category', () => {
    const category = at(normalizeCategories([{ name: 'delivery', product: 'Shop', owners: [{ username: 'olga' }] }]), 0)
    expect(category).toMatchObject({ name: 'delivery', product: 'Shop', owners: [] })
  })

  it('omits absent product/owners so a legacy row round-trips unchanged', () => {
    const category = at(normalizeCategories([{ id: 'cat_a', name: 'a', subcategories: [] }]), 0)
    expect(category).not.toHaveProperty('product')
    expect(category).not.toHaveProperty('owners')
  })
})

describe('normalizeOwnerCandidates', () => {
  it('offers enabled users that carry a sub', () => {
    expect(normalizeOwnerCandidates([
      { sub: 's1', username: 'ada', email: 'a@x', enabled: true, groups: ['admins'] },
      { sub: 's2', username: 'off', email: 'o@x', enabled: false },
      { username: 'nosub', email: 'n@x', enabled: true },
    ])).toStrictEqual([{ sub: 's1', username: 'ada', email: 'a@x' }])
  })
})
