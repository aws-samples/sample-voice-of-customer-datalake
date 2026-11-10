#!/usr/bin/env node

/**
 * The dev mock's in-place feedback edits stamp the record like the API (`updated_at`, `updated_by`,
 * `change_reason`), and the Data Explorer save refuses a stale editor with the API's 409: the editor sends
 * the `updated_at` it opened, '' when the record had none. Boots mock-server.js on a free port.
 *
 * Run: node --test scripts/mock-edit-stamp.test.mjs
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { mockCaller, useMockServer } from './mock-server-harness.mjs'

const mock = useMockServer()

const call = mockCaller(mock)

/** A listed review and a configured category other than its own. */
async function aReviewAndAnotherCategory() {
  const [, list] = await call('GET', '/feedback?days=0&limit=5')
  const [review] = list.items
  const [, config] = await call('GET', '/settings/categories')
  const other = config.categories.find((c) => c.name !== review.category)
  return { review, category: other.name }
}

const saveFromExplorer = (review, data) =>
  call('PUT', '/data-explorer/feedback', { feedback_id: review.feedback_id, data: { source_platform: review.source_platform, ...data } })

describe('dev mock: feedback edits are stamped and a stale Data Explorer save is refused', () => {
  it('stamps a category edit, and then refuses an editor opened before it', async () => {
    const { review, category } = await aReviewAndAnotherCategory()
    const opened = review.updated_at ?? ''

    const [moved] = await call('PUT', `/feedback/${review.feedback_id}/category`, { category })
    assert.equal(moved, 200)
    const [, after] = await call('GET', `/feedback/${review.feedback_id}`)
    assert.notEqual(after.updated_at ?? '', opened)
    assert.equal(after.change_reason, 'category_edit')

    const [status, body] = await saveFromExplorer(review, { urgency: 'high', updated_at: opened })
    assert.equal(status, 409)
    assert.equal(body.error, 'This review was changed by someone else. Reload and retry.')
  })

  it('saves an editor opened with the current stamp and stamps the Data Explorer edit', async () => {
    const { review } = await aReviewAndAnotherCategory()
    const [, current] = await call('GET', `/feedback/${review.feedback_id}`)

    const [status] = await saveFromExplorer(review, { urgency: 'low', updated_at: current.updated_at ?? '' })
    assert.equal(status, 200)
    const [, saved] = await call('GET', `/feedback/${review.feedback_id}`)
    assert.equal(saved.change_reason, 'data_explorer_edit')
    assert.deepEqual(saved.updated_by, { sub: 'mock-admin', kind: 'admin' })
  })

  it('stamps a dimensions edit', async () => {
    const { review } = await aReviewAndAnotherCategory()
    const [status] = await call('PUT', `/feedback/${review.feedback_id}/dimensions`, { tags: ['vip'] })
    assert.equal(status, 200)
    const [, after] = await call('GET', `/feedback/${review.feedback_id}`)
    assert.equal(after.change_reason, 'dimensions_edit')
  })
})
