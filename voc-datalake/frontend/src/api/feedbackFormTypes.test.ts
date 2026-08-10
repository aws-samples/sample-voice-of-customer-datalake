/**
 * Guards the type boundary between the authenticated feedback-form shape and the
 * public widget shape.
 *
 * `FeedbackFormFields` is shared: `FeedbackFormConfig` extends it and is the
 * response body of `GET /feedback-forms/{id}/config`, which is unauthenticated
 * and fetched cross-origin from customers' own websites. The project/document a
 * form validates are internal identifiers, so they belong on `FeedbackForm`
 * alone. Moving them up to the shared base would publish them.
 *
 * A type-level constraint cannot fail a test run, so this asserts over the
 * declaration text instead — the same approach `lib/stacks/api-stack.test.ts`
 * takes for its authorization invariant.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const LINK_FIELDS = ['project_id', 'document_id']

/**
 * The body of one `interface X { ... }` declaration in types.ts, with comments
 * stripped.
 *
 * The assertions below are about what an interface *declares*. A comment inside
 * `FeedbackFormFields` that merely mentions `project_id` — to record why it is
 * deliberately absent, say — declares nothing, and failing on it would punish
 * exactly the documentation that keeps this invariant understood.
 */
function interfaceBody(source: string, name: string): string {
  const start = source.indexOf(`interface ${name} `)
  expect(start, `interface ${name} not found — was it renamed?`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', start)
  const close = source.indexOf('\n}', open)
  expect(close, `interface ${name} is not brace-delimited as expected`).toBeGreaterThan(open)
  return source.slice(open, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

describe('feedback form type boundary', () => {
  const source = readFileSync(join(__dirname, 'types.ts'), 'utf-8')

  it('declares the validation link on FeedbackForm', () => {
    const body = interfaceBody(source, 'FeedbackForm')

    for (const field of LINK_FIELDS) {
      expect(body, `FeedbackForm should declare ${field}`).toContain(field)
    }
  })

  it('keeps the validation link off the shared base FeedbackFormFields', () => {
    const body = interfaceBody(source, 'FeedbackFormFields')

    for (const field of LINK_FIELDS) {
      expect(
        body,
        `${field} on FeedbackFormFields would publish it through FeedbackFormConfig, `
        + 'the body of the unauthenticated widget config route.',
      ).not.toContain(field)
    }
  })

  it('keeps the validation link off the public widget shape FeedbackFormConfig', () => {
    const body = interfaceBody(source, 'FeedbackFormConfig')

    for (const field of LINK_FIELDS) {
      expect(body).not.toContain(field)
    }
  })
})
