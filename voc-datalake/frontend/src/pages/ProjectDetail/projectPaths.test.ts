/**
 * A project page's address as paths: each tab, a document, an older version and full screen have one path that
 * reads back as the same place; an unknown tab or tail reads as the nearest place, flagged for replacing; an old
 * `?tab=` / `?doc=` / `?view=focus` link reads as its path's place, keeping every other parameter.
 */
import { describe, expect, it } from 'vitest'
import { decisionDeepLink } from './decisions/decisionDraft'
import {
  documentPlace, legacyPlace, parseProjectRest, projectDocumentPath, projectPlacePath, tabPlace,
} from './projectPaths'
import type { ProjectPlace } from './projectPaths'

const rest = (path: string) => path.replace(/^\/projects\/p1\/?/, '')

describe('projectPlacePath and parseProjectRest', () => {
  const places: [string, ProjectPlace][] = [
    ['/projects/p1/overview', tabPlace('overview')],
    ['/projects/p1/personas', tabPlace('personas')],
    ['/projects/p1/product', tabPlace('product')],
    ['/projects/p1/documents', tabPlace('documents')],
    ['/projects/p1/decisions', tabPlace('decisions')],
    ['/projects/p1/participants', tabPlace('participants')],
    ['/projects/p1/documents/prfaq_3', documentPlace('prfaq_3')],
    ['/projects/p1/documents/prfaq_3/v/2', { ...documentPlace('prfaq_3'), version: 2 }],
    ['/projects/p1/documents/prfaq_3/focus', { ...documentPlace('prfaq_3'), focus: true }],
    ['/projects/p1/documents/prfaq_3/v/2/focus', { ...documentPlace('prfaq_3'), version: 2, focus: true }],
  ]

  it.each(places)('%s is the path of its place, and reads back as it', (path, place) => {
    expect(projectPlacePath('p1', place)).toBe(path)
    expect(parseProjectRest(rest(path))).toStrictEqual({ place, canonical: true })
  })

  it('reads the project itself as its Overview', () => {
    expect(parseProjectRest('')).toStrictEqual({ place: tabPlace('overview'), canonical: true })
  })

  it.each([
    ['mcp', tabPlace('overview')],
    ['chat', tabPlace('overview')],
    ['personas/extra', tabPlace('personas')],
    ['documents/prfaq_3/v/0', documentPlace('prfaq_3')],
    ['documents/prfaq_3/v/two', documentPlace('prfaq_3')],
    ['documents/prfaq_3/garbage', documentPlace('prfaq_3')],
  ])('reads %s as the nearest place, to be replaced', (tail, place) => {
    expect(parseProjectRest(tail)).toStrictEqual({ place, canonical: false })
  })

  it('encodes the ids it puts in a path', () => {
    expect(projectDocumentPath('p 1', 'doc#2')).toBe('/projects/p%201/documents/doc%232')
  })
})

describe('legacyPlace (an old query link)', () => {
  it.each([
    ['?tab=documents&doc=prfaq_1&view=focus', { ...documentPlace('prfaq_1'), focus: true }, ''],
    ['?tab=documents&doc=prfaq_1', documentPlace('prfaq_1'), ''],
    ['?doc=prfaq_1', documentPlace('prfaq_1'), ''],
    ['?tab=personas&doc=prfaq_1', tabPlace('personas'), ''],
    ['?tab=documents&view=focus', tabPlace('documents'), ''],
    ['?tab=mcp', tabPlace('overview'), ''],
    ['?tab=decisions&newDecision=1&title=Go', tabPlace('decisions'), '?newDecision=1&title=Go'],
    ['?review=fb_9&tab=documents&doc=d1', documentPlace('d1'), '?review=fb_9'],
  ])('reads %s on the project itself', (search, place, kept) => {
    expect(legacyPlace('', search)).toStrictEqual({ place, search: kept })
  })

  it('is nothing for an address without the old parameters', () => {
    expect(legacyPlace('', '?review=fb_9')).toBeNull()
    expect(legacyPlace('documents/d1', '')).toBeNull()
  })

  it('only drops them on a path that names its place already', () => {
    expect(legacyPlace('documents/d1', '?tab=personas&q=x')).toStrictEqual({ place: documentPlace('d1'), search: '?q=x' })
  })
})

describe('the in-app links that open a place', () => {
  it('opens a document by its path', () => {
    expect(projectDocumentPath('p1', 'prfaq_1')).toBe('/projects/p1/documents/prfaq_1')
  })

  it('opens the Decisions tab with a prefilled decision by its path, the prefill in the query', () => {
    expect(decisionDeepLink('p1', { title: 'Go' })).toBe('/projects/p1/decisions?newDecision=1&title=Go')
  })
})
