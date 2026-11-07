/**
 * @fileoverview The workflow editor's methodology warnings (`POST /workflows/validate` → `warnings`):
 * each line names its step by title, a known code in the reader's language, an unknown one in the
 * server's words; nothing renders without warnings.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import MethodologyWarnings from './MethodologyWarnings'
import { withPrdStep } from '@test/workflowFixtures'
import { emptyDefinition } from './model-fixtures'

/** start → "Write the PRD" → end: a PRD with nothing before it. */
const DEFINITION = withPrdStep(emptyDefinition('Straight to the PRD'))

describe('MethodologyWarnings', () => {
  it('names the step and says what is missing before it', () => {
    render(<MethodologyWarnings definition={DEFINITION} warnings={[
      { code: 'no_upstream_evidence', message: 'server', node_id: 'prd' },
      { code: 'no_upstream_prfaq', message: 'server', node_id: 'prd' },
    ]} />)
    const text = screen.getByTestId('workflow-methodology-warnings').textContent
    expect(text).toContain('Advice only: the workflow still saves and runs.')
    expect(text).toContain('Write the PRD: no customer evidence before it (aggregate reviews or deep research).')
    expect(text).toContain('Write the PRD: no PR/FAQ step before it: the methodology writes the PR/FAQ first.')
  })

  it("shows the server's sentence for an unknown code, and the node id for an unknown step", () => {
    render(<MethodologyWarnings definition={DEFINITION} warnings={[
      { code: 'a_future_rule', message: 'A future rule, in English.', node_id: 'gone' },
    ]} />)
    expect(screen.getByTestId('workflow-methodology-warnings').textContent).toContain('gone: A future rule, in English.')
  })

  it('renders nothing without warnings', () => {
    render(<MethodologyWarnings definition={DEFINITION} warnings={[]} />)
    expect(screen.queryByTestId('workflow-methodology-warnings')).toBeNull()
  })
})
