/**
 * The current workspace's header: `X-Workspace-Id` only while a workspace is set, and only to a trusted
 * origin (the Authorization header's rule), so a workspace id never reaches a foreign host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

vi.mock('../runtimeConfig', () => import('@test/api-mocks').then(m =>
  m.runtimeConfigMock('https://abc123.execute-api.us-east-1.amazonaws.com/v1')))

import { setCurrentWorkspace, useCurrentWorkspace, workspaceHeader } from './currentWorkspace'
import { useAppOrigin } from '@test/location'

const API = 'https://abc123.execute-api.us-east-1.amazonaws.com/v1'
import { ACME } from '../test/workspaceFixtures'

afterEach(() => setCurrentWorkspace(null))

describe('workspaceHeader', () => {
  useAppOrigin()

  it('names the current workspace to the deployment API and to the page origin', () => {
    setCurrentWorkspace(ACME)
    expect(workspaceHeader(`${API}/feedback`)).toStrictEqual({ 'X-Workspace-Id': ACME.id })
    expect(workspaceHeader('/api/feedback')).toStrictEqual({ 'X-Workspace-Id': ACME.id })
  })

  it.each([
    ['a foreign origin', 'https://attacker.example.com/collect'],
    ['a backslash trick', '/\\evil.example.com/collect'],
    ['no target', ''],
  ])('sends nothing to %s, while a workspace is set', (_label, url) => {
    setCurrentWorkspace(ACME)
    expect(workspaceHeader(`${API}/feedback`)).toStrictEqual({ 'X-Workspace-Id': ACME.id })
    expect(workspaceHeader(url)).toStrictEqual({})
  })

  it('sends nothing outside a workspace', () => {
    expect(workspaceHeader(`${API}/feedback`)).toStrictEqual({})
  })
})

describe('useCurrentWorkspace', () => {
  it('follows the store', () => {
    const { result } = renderHook(() => useCurrentWorkspace())
    expect(result.current).toBeNull()
    act(() => setCurrentWorkspace(ACME))
    expect(result.current).toStrictEqual(ACME)
  })
})
