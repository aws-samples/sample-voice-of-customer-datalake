/** knownSourceIds: the source ids reviews really carry (docs/source-policies.md). */
import { describe, expect, it } from 'vitest'
import { knownSourceIds, newIdProblem, newProfile } from './sourceDraft'

describe('knownSourceIds', () => {
  it('lists plugins, the platform sources and valid scraper names, never the webscraper plugin id', () => {
    expect(knownSourceIds(['webscraper', 'github_issues'], ['trustpilot_reviews', 'Shop Reviews', 'www.example.com']))
      .toStrictEqual(['github_issues', 'trustpilot_reviews', 'feedback_form', 'manual_import'])
  })

  it('works without scrapers', () => {
    expect(knownSourceIds(['webscraper'])).toStrictEqual(['feedback_form', 'manual_import'])
  })
})

describe('newIdProblem', () => {
  it('refuses csv_upload as a new id: its folder holds whole-file uploads', () => {
    expect(newIdProblem('csv_upload', [])).toBe('components:sourcesManager.problems.idReserved')
  })

  it('refuses json_upload as a new id', () => {
    expect(newIdProblem('json_upload', [])).toBe('components:sourcesManager.problems.idReserved')
  })

  it('still names a reserved id already in the list as a duplicate', () => {
    expect(newIdProblem('csv_upload', [newProfile('csv_upload')])).toBe('components:sourcesManager.problems.idDuplicate')
  })

  it('accepts the paste and form sources', () => {
    expect([newIdProblem('manual_import', []), newIdProblem('feedback_form', [])]).toStrictEqual([null, null])
  })
})
