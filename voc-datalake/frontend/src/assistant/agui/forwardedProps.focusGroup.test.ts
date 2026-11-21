/**
 * @fileoverview forwardedProps carry a persona focus group from its project's page only, within the contract's
 * limits, and without mentions (a group names its own personas and documents).
 */
import { describe, expect, it } from 'vitest'
import { buildForwardedProps } from './forwardedProps'

const CONFIG = { persona_ids: ['pa', 'pb'], rounds: 2, documents: [{ document_id: 'd1' }] }

describe('forwardedProps — focus groups', () => {
  const PROJECT = { kind: 'project' as const, path: '/projects/p1', projectId: 'p1' }

  it('carries a focus group from a project page, without mentions', () => {
    const props = buildForwardedProps({ page: PROJECT, language: 'en', useWebSearch: false, focusGroup: CONFIG,
      mentions: { personas: 'all' } })
    expect({ focusGroup: props.focusGroup, mentions: props.mentions }).toStrictEqual({ focusGroup: CONFIG, mentions: undefined })
  })

  it('drops a focus group off a project page or past its limits', () => {
    expect(buildForwardedProps({ page: { kind: 'dashboard', path: '/' }, language: 'en', useWebSearch: false,
      focusGroup: CONFIG }).focusGroup).toBeUndefined()
    expect(buildForwardedProps({ page: PROJECT, language: 'en', useWebSearch: false,
      focusGroup: { persona_ids: ['one'], rounds: 1 } }).focusGroup).toBeUndefined()
  })
})
