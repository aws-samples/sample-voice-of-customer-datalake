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
import { normalizeCategories } from './categoriesSchema'

const legacyRow = { name: 'app', display_name: 'Mobile App', description: 'App experience', color: '#EC4899' }

describe('normalizeCategories (issue #181)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives a legacy row a derived id and an empty subcategories array', () => {
    const [category] = normalizeCategories([legacyRow])

    expect(category.id).toBe('cat_app')
    expect(category.subcategories).toEqual([])
    expect(category.name).toBe('app')
  })

  it('passes legacy fields through so a save round-trip loses nothing', () => {
    const [category] = normalizeCategories([legacyRow])

    expect(category).toMatchObject({ display_name: 'Mobile App', color: '#EC4899' })
  })

  it('keeps a complete row unchanged', () => {
    const complete = {
      id: 'cat_delivery',
      name: 'delivery',
      description: 'Shipping issues',
      subcategories: [{ id: 'sub_late', name: 'late_delivery', description: 'Late' }],
    }

    expect(normalizeCategories([complete])).toEqual([complete])
  })

  it('treats explicit null subcategories like missing (DynamoDB emits both)', () => {
    const [category] = normalizeCategories([{ ...legacyRow, subcategories: null }])

    expect(category.subcategories).toEqual([])
  })

  it('salvages valid subcategory items, deriving missing sub ids', () => {
    const [category] = normalizeCategories([{
      id: 'cat_x', name: 'x',
      subcategories: [
        { name: 'late delivery' },
        'junk-string',
        { id: 'sub_ok', name: 'ok' },
      ],
    }])

    expect(category.subcategories).toEqual([
      { id: 'sub_late_delivery', name: 'late delivery' },
      { id: 'sub_ok', name: 'ok' },
    ])
  })

  it('derives ids deterministically so repeated loads agree', () => {
    const first = normalizeCategories([legacyRow])
    const second = normalizeCategories([legacyRow])

    expect(first[0].id).toBe(second[0].id)
  })

  it('drops a row only when both id and name are unusable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const categories = normalizeCategories([
      legacyRow,
      { description: 'nothing to key on' },
      { id: '', name: '' },
    ])

    expect(categories.map((c) => c.id)).toEqual(['cat_app'])
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
