/**
 * 3.00.00: a workflow custom step (`custom_llm`) reports no verdict, so it carries
 * no pass / fail arrows (docs/autonomous-agents.md). Both roles, read-only:
 * `POST /workflows/validate` stores nothing.
 *
 * - Given start → custom step → end, When its arrow is labelled `pass` or `fail`,
 *   Then validate answers `valid: false` with the error pinned to the custom step.
 * - The same workflow with a plain arrow is valid.
 *
 * The editor side (no pass / fail offered out of a custom step) is covered by
 * `WorkflowEditor/NodeConfigPanel.test.tsx` and `model.test.ts`; stored workflows
 * that still carry such an arrow are normalised on read (lambda tests).
 */
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall } from '../lib/api'
import { roleOf } from '../lib/fixtures'

function customStepWorkflow(label?: 'pass' | 'fail'): Record<string, unknown> {
  return {
    schema: 'voc-workflow/1',
    name: 'e2e custom-step arrows (validate only)',
    description: '',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start', params: {} } },
      { id: 'custom', type: 'custom_llm', position: { x: 0, y: 120 }, data: { title: 'Think', instructions: 'Summarise.', params: {} } },
      { id: 'end', type: 'end', position: { x: 0, y: 240 }, data: { title: 'End', params: {} } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'custom' },
      { id: 'e2', source: 'custom', target: 'end', ...(label === undefined ? {} : { label }) },
    ],
    loops: [],
  }
}

function errorsOf(body: unknown): Array<{ message?: unknown; node_id?: unknown }> {
  if (typeof body !== 'object' || body === null || !('errors' in body) || !Array.isArray(body.errors)) return []
  return body.errors.filter((e): e is { message?: unknown; node_id?: unknown } => typeof e === 'object' && e !== null)
}

test.describe('workflows: custom steps carry no pass / fail arrows', () => {
  for (const label of ['pass', 'fail'] as const) {
    test(`validate refuses a '${label}' arrow out of a custom step`, async ({}, testInfo) => {
      const res = await apiCall(roleOf(testInfo), 'POST', '/workflows/validate', { definition: customStepWorkflow(label) })
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ valid: false })
      expect(errorsOf(res.body)).toContainEqual({
        message: `a custom step reports no pass/fail verdict, so its arrows cannot be '${label}' — use a plain arrow`,
        node_id: 'custom',
      })
    })
  }

  test('validate accepts the plain arrow', async ({}, testInfo) => {
    const res = await apiCall(roleOf(testInfo), 'POST', '/workflows/validate', { definition: customStepWorkflow() })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ valid: true })
  })
})
