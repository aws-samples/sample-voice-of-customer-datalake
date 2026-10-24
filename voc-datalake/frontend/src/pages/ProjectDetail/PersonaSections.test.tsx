/**
 * Live finding: the persona detail printed "Income bracket: undefined". Empty
 * attributes — missing, null, blank or a stand-in like "undefined" — never print,
 * and a section with nothing left to show is not rendered.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BehaviorsSection, ContextSection, GoalsSection, IdentitySection, QuotesSection, ScenarioSection } from './PersonaSections'
import { shownList, shownText } from './personaHelpers'
import type { ProjectPersona } from '../../api/projectTypes'

const base: ProjectPersona = { persona_id: 'p1', name: 'Ada', tagline: '', created_at: '' }

/** A persona whose stored fields came back with nulls (the wire is untyped JSON). */
function withWire(fields: Record<string, unknown>): ProjectPersona {
  return Object.assign({}, base, fields)
}

describe('shownText / shownList', () => {
  it('hides missing, blank and stand-in values', () => {
    expect([undefined, null, '', '  ', 'undefined', 'NULL', 'N/A', {}].map(shownText)).toStrictEqual(Array(8).fill(null))
  })

  it('keeps real text and numbers, trimmed', () => {
    expect([' Lisbon ', 34].map(shownText)).toStrictEqual(['Lisbon', '34'])
  })

  it('drops empty list entries and reads a non-list as empty', () => {
    expect(shownList(['Phone', '', null, 'undefined', 'Laptop'])).toStrictEqual(['Phone', 'Laptop'])
    expect(shownList('Phone')).toStrictEqual([])
  })
})

describe('persona sections', () => {
  it('never prints an empty identity attribute', () => {
    render(<IdentitySection persona={withWire({ identity: { income_bracket: 'undefined', location: null, occupation: 'Designer', education: '' } })} />)
    expect(screen.getByText('Occupation: Designer')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/undefined|null|Income bracket|Location|Education/)
  })

  it('hides a section whose every field is empty', () => {
    const empty = withWire({
      identity: { bio: '', income_bracket: 'undefined' }, goals_motivations: { primary_goal: null, secondary_goals: [''] },
      behaviors: { tools_used: [], tech_savviness: 'null' }, context_environment: { devices: [null] },
      quotes: [{ text: '' }], scenario: { title: '', trigger: 'undefined' },
    })
    const { container } = render(<>
      <IdentitySection persona={empty} /><GoalsSection persona={empty} /><BehaviorsSection persona={empty} />
      <ContextSection persona={empty} /><QuotesSection persona={empty} /><ScenarioSection persona={empty} />
    </>)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the fields that used to be dropped (success, social context, influencers)', () => {
    const persona = withWire({
      goals_motivations: { success_definition: 'Ships weekly' },
      context_environment: { social_context: 'Small team', influencers: ['Their manager'] },
    })
    render(<><GoalsSection persona={persona} /><ContextSection persona={persona} /></>)
    expect(screen.getByText('Ships weekly')).toBeInTheDocument()
    expect(screen.getByText('Small team')).toBeInTheDocument()
    expect(screen.getByText('Their manager')).toBeInTheDocument()
  })
})
