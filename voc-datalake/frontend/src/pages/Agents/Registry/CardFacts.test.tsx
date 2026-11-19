/**
 * @fileoverview A Registry card's "Uses skills" (7.56.00): the library skills its role uses, each linking to its page
 * in Skills → Library; nothing at all for a role that uses none.
 */
import { describe, it, expect } from 'vitest'
import { screen, within } from '@testing-library/react'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { parseRegistry } from '../../../api/engineeringRegistryApi'
import { CardFacts } from './CardFacts'

const ROLE = {
  kind: 'role', id: 'hunter', base_role: 'hunter', title: 'hunter', purpose: 'Finds the bug.', launchable: true,
  template: { version: 4, label: 'hunter@template-4', digest: 'sha256:h' },
  skill: { source: 'template', label: 'hunter@template-4', connection: null, version: null, provenance: 'template', template_version: 4 },
  model: 'model-s', tools: ['read_file', 'read_skill'], harness: 'converse', caps: {}, inputs: [], outputs: [],
}

function renderFacts(skills: unknown) {
  const [card] = parseRegistry({ cards: [{ ...ROLE, skills }] })
  if (card === undefined) throw new Error('the card did not parse')
  return renderWithQueryClient(<TestRouter><CardFacts card={card} /></TestRouter>)
}

describe('Agents → Registry: a card\'s library skills', () => {
  it('lists each skill its role uses, linking to its page in the Library', () => {
    renderFacts(['systematic-debugging', 'security-audit'])
    const list = screen.getByRole('list', { name: 'Uses skills' })
    expect(within(list).getByRole('link', { name: 'systematic-debugging' })).toHaveAttribute('href', '/agents/skills/library/systematic-debugging')
    expect(within(list).getAllByRole('link').map((link) => link.textContent)).toStrictEqual(['systematic-debugging', 'security-audit'])
  })

  it('says nothing of skills for a role that uses none, or a card from before the library', () => {
    renderFacts([])
    expect(screen.queryByText('Uses skills')).not.toBeInTheDocument()
    expect(screen.getByText('read_file, read_skill')).toBeInTheDocument()
  })

  it('reads an unreadable skills field as none', () => {
    renderFacts('tdd')
    expect(screen.queryByRole('list', { name: 'Uses skills' })).not.toBeInTheDocument()
  })
})
