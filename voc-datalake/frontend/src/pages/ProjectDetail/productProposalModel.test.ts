/**
 * The review's rules as data (7.104.00): what an accept can take, what Accept all takes (proposed rows only: a conflict
 * needs its own selection), the accept's body (`seen`, or
 * the new value of a field changed since the extract; an edit only when it differs), and the form's badged fields.
 */
import { describe, expect, it } from 'vitest'
import { fieldProposal, proposalOf } from './product-sources-fixtures'
import { acceptAllFields, acceptBody, isReviewable, proposedFields } from './productProposalModel'

const proposal = proposalOf({
  product_name: fieldProposal({ status: 'proposed', value: 'A', seen: '' }),
  one_liner: fieldProposal({ status: 'conflict', value: 'B', seen: 'b', current: 'b2', changed_since: true }),
  key_features: fieldProposal({ status: 'proposed', value: 'C', accepted: true }),
  non_goals: fieldProposal({ status: 'unchanged', value: 'D' }),
  target_users: fieldProposal({ status: 'conflict', value: 'E', seen: 'e', current: 'e' }),
})

describe('productProposalModel', () => {
  it('takes for Accept all every proposed row not accepted and unchanged since the extract, never a conflict', () => {
    expect(acceptAllFields(proposal)).toStrictEqual(['product_name'])
    expect(acceptBody(proposal, ['target_users'], {})).toStrictEqual({ fields: { target_users: { seen: 'e' } } })
  })

  it('builds the body against `seen`, or a changed field\'s new value, with an edit only when it differs', () => {
    expect(acceptBody(proposal, ['product_name', 'one_liner'], { product_name: 'A', one_liner: 'B!' })).toStrictEqual({
      fields: { product_name: { seen: '' }, one_liner: { seen: 'b2', value: 'B!' } },
    })
  })

  it('badges the acceptable fields of an open or partly applied proposal only', () => {
    expect([...proposedFields(proposal)]).toStrictEqual(['product_name', 'one_liner', 'target_users'])
    expect(proposedFields({ ...proposal, status: 'superseded' }).size).toBe(0)
    expect(proposedFields(null).size).toBe(0)
    expect(['open', 'partly_applied', 'applied', 'dismissed'].map(isReviewable)).toStrictEqual([true, true, false, false])
  })
})
