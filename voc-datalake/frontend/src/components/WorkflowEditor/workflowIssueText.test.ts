/**
 * @fileoverview Workflow issues written in field names read as plain translated sentences
 * (5.34.00 live: the editor said "instructions is required").
 */
import { describe, expect, it } from 'vitest'
import i18n from 'i18next'
import { workflowIssueText } from './workflowIssueText'

const t = i18n.getFixedT('en', 'agents')

describe('workflowIssueText', () => {
  it.each([
    ['instructions is required', 'This step needs instructions: say what it should do.'],
    ['title is required', 'Give this step a title.'],
    ['persona_review needs params.target: one of prfaq, prd, prototype', 'Choose what this review checks.'],
    ['end params.status must be one of completed, needs_human', 'Choose how the run ends here.'],
  ])('%s', (message, text) => {
    expect(workflowIssueText(t, message)).toBe(text)
  })

  it('a message already written for people is shown as it is', () => {
    expect(workflowIssueText(t, 'only the loop\'s review can leave the loop')).toBe('only the loop\'s review can leave the loop')
  })
})
