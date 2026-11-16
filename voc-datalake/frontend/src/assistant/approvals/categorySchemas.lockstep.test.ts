/**
 * LOCKSTEP: the save_categories approval boundary (./categorySchemas) ⇄ the stream Lambda's
 * (`lambda/stream/src/assistant/tools/client/category-schemas.ts`, pinned there to lambda/shared/category_config.py)
 * ⇄ the categories editor (CategoriesManager `toSlug`). A set one side accepts and the other refuses would be a card
 * the model proposes but the person cannot approve, or names the editor would store differently.
 */
import { describe, it, expect } from 'vitest'
import * as stream from '../../../../lambda/stream/src/assistant/tools/client/category-schemas'
import { toSlug } from '../../components/CategoriesManager/categoryEntries'
import { checkedDraft, draftOf, namesTaken, newCategories, saveCategoriesArgs } from './categorySchemas'

const category = (label: string, subcategories: string[] = [], product?: string) =>
  ({ label, subcategories, ...(product === undefined ? {} : { product }) })

describe('save_categories: stream ⇄ SPA', () => {
  it.each<[string, unknown]>([
    ['one category', { categories: [category('Delivery', ['Late delivery'], 'Shop')] }],
    ['folded whitespace and a blank product', { categories: [category('  Late   delivery ', ['a'], '  ')] }],
    ['ten categories', { categories: Array.from({ length: 10 }, (_, i) => category(`C${String(i)}`)) }],
    ['eleven categories', { categories: Array.from({ length: 11 }, (_, i) => category(`C${String(i)}`)) }],
    ['none', { categories: [] }],
    ['six subcategories', { categories: [category('Delivery', ['a', 'b', 'c', 'd', 'e', 'f'])] }],
    ['a name twice', { categories: [category('Delivery'), category('DELIVERY')] }],
    ['a subcategory twice', { categories: [category('Delivery', ['Late', 'late '])] }],
    ['a "#"', { categories: [category('A#B')] }],
    ['the wildcard', { categories: [category('*')] }],
    ['a label of 65', { categories: [category('x'.repeat(65))] }],
    ['a product of 121', { categories: [category('Delivery', [], 'p'.repeat(121))] }],
    ['an unknown key', { categories: [{ ...category('Delivery'), owners: [] }] }],
    ['no subcategories key', { categories: [{ label: 'Delivery' }] }],
  ])('both sides judge %s alike, and parse it to the same set', (_what, args) => {
    const spa = saveCategoriesArgs.safeParse(args)
    const tool = stream.saveCategoriesArgsSchema.safeParse(args)
    expect([spa.success, spa.data]).toStrictEqual([tool.success, tool.data])
  })

  it.each(['Delivery', 'Late delivery', 'Zahlung  & Rechnung', 'ÜBER uns'])('stores %j as the categories editor does', (label) => {
    const folded = stream.foldedLabel(label)
    expect(stream.categorySlug(folded)).toBe(toSlug(folded.trim()))
  })
})

describe('the card’s edited set', () => {
  const stored = [{ id: 'cat_billing', name: 'billing', description: 'Billing', subcategories: [] }]

  it('starts from the proposal and is valid as it came', () => {
    const args = saveCategoriesArgs.parse({ categories: [category('Delivery', ['Late'], 'Shop')] })
    expect(draftOf(args)).toStrictEqual([{ label: 'Delivery', product: 'Shop', subcategories: ['Late'] }])
    expect(checkedDraft(draftOf(args), stored)).toStrictEqual({ ok: true, set: args })
  })

  it('names each field that is not right, and a name configured already (without regard to case)', () => {
    const checked = checkedDraft([
      { label: 'Billing', product: '', subcategories: ['ok', 'a#b'] },
      { label: 'Returns', product: 'p'.repeat(121), subcategories: [] },
      { label: 'returns', product: '', subcategories: [] },
    ], stored)
    expect(checked.ok).toBe(false)
    expect(checked.ok ? [] : [...checked.problems]).toStrictEqual(expect.arrayContaining([
      ['categories.0.label', 'taken'], ['categories.0.subcategories.1', 'label'], ['categories.1.product', 'product'],
      ['categories.2.label', 'repeated'],
    ]))
    expect(checkedDraft([], stored)).toStrictEqual({ ok: false, problems: new Map([['categories', 'none']]) })
  })

  it('makes stored categories as the editor does: fresh ids, the slug as the name, the label shown', () => {
    const set = saveCategoriesArgs.parse({ categories: [category('Late delivery', ['Lost parcel'], 'Shop')] })
    const minted: string[] = []
    const ids = (prefix: string) => {
      minted.push(prefix)
      return `${prefix}_${String(minted.length)}`
    }
    expect(newCategories(set, ids)).toStrictEqual([{
      id: 'cat_1', name: 'late_delivery', description: 'Late delivery', product: 'Shop',
      subcategories: [{ id: 'sub_2', name: 'lost_parcel', description: 'Lost parcel' }],
    }])
    expect(namesTaken(saveCategoriesArgs.parse({ categories: [category('BILLING'), category('New')] }), stored)).toStrictEqual(['billing'])
  })
})
