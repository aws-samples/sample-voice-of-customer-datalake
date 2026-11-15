/**
 * The details under the page's title (DocumentMeta): its creator when the project lists them, else the project's
 * owner (each said as such), when it was edited (relative, mid-sentence), how long it reads, and its type.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import DocumentMeta from './DocumentMeta'
import type { ProjectDocument } from '../../../api/types'

const owner = { sub: 'sub-owner', username: 'olivia', email: 'olivia@example.com' }
const member = { sub: 'sub-ada', role: 'editor' as const, username: 'ada', email: 'ada@example.com' }
const project = makeProject({ owner, members: [member] })
const note: ProjectDocument = {
  document_id: 'd1', document_type: 'custom', title: 'Notes', content: '', created_at: '2026-01-05T00:00:00Z',
}

const chips = () => within(screen.getByRole('list', { name: 'Document details' })).getAllByRole('listitem').map((chip) => chip.textContent)

describe('DocumentMeta', () => {
  it('names the creator the project lists, and counts the words being written', () => {
    render(<DocumentMeta project={project} document={{ ...note, created_by_sub: 'sub-ada' }} text={'word '.repeat(450)} />)
    expect(chips()).toStrictEqual(['By ada', expect.stringMatching(/^Edited /), '450 words · 2 min read', 'CUSTOM'])
  })

  it('names the project\'s owner, as the owner, when the creator is not known', () => {
    render(<DocumentMeta project={project} document={note} text="" />)
    expect(chips()).toStrictEqual(['Owner: olivia', expect.stringMatching(/^Edited /), '0 words', 'CUSTOM'])
  })

  it('says when it was edited mid-sentence ("Edited yesterday"), from its last edit', () => {
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    render(<DocumentMeta project={makeProject({ owner: null })} document={{ ...note, updated_at: yesterday }} text="One" />)
    expect(chips()).toStrictEqual([expect.stringMatching(/^Edited (yesterday|[A-Z][a-z]{2} \d+)$/), '1 word · 1 min read', 'CUSTOM'])
  })
})
