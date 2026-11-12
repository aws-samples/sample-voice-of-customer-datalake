/**
 * The refusal tables: a status and, where two refusals share one, the server's exact reason pick the message;
 * anything else is the generic message, with the server's reason when it gave one.
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../lib/errors'
import { MEMBER_REFUSALS, PLATFORM_ADMIN_REFUSALS, PLATFORM_REFUSALS, workspaceRefusalMessage } from './workspaceRefusals'

const LAST_ADMIN = 'A workspace needs an admin: make another member an admin first'
const CHANGED = 'The membership changed meanwhile: reload the members and try again'

describe('workspaceRefusalMessage', () => {
  it('tells two 409s of the members routes apart by their reason', () => {
    expect([
      workspaceRefusalMessage(new ApiError(409, LAST_ADMIN), MEMBER_REFUSALS).messageKey,
      workspaceRefusalMessage(new ApiError(409, CHANGED), MEMBER_REFUSALS).messageKey,
    ]).toStrictEqual(['common:workspaces.errors.lastAdmin', 'common:workspaces.errors.changedMeanwhile'])
  })

  it('says "no longer admin", a new email\'s refusal, and any other 403, each its own way', () => {
    const keys = [
      new ApiError(403, 'You are no longer an admin of this workspace'),
      new ApiError(403, 'This email has no account yet: only a deployment administrator can create one while the data is shared across workspaces'),
      new ApiError(403, 'Workspace admin access required'),
    ].map((error) => workspaceRefusalMessage(error, MEMBER_REFUSALS).messageKey)
    expect(keys).toStrictEqual([
      'common:workspaces.errors.noLongerAdmin', 'common:workspaces.errors.newAccountAdminsOnly', 'common:workspaces.errors.notWorkspaceAdmin',
    ])
  })

  it('maps the platform console\'s taken slug and the last platform admin', () => {
    expect([
      workspaceRefusalMessage(new ApiError(409, 'That slug is taken: choose another'), PLATFORM_REFUSALS).messageKey,
      workspaceRefusalMessage(new ApiError(409, 'This is the last enabled platform admin: make another administrator a platform admin first.'), PLATFORM_ADMIN_REFUSALS).messageKey,
    ]).toStrictEqual(['common:workspaces.errors.slugTaken', 'common:workspaces.errors.lastPlatformAdmin'])
  })

  it('falls back to the generic message, with the server\'s reason when there is one', () => {
    expect(workspaceRefusalMessage(new ApiError(400, 'name must not contain control characters'), PLATFORM_REFUSALS))
      .toStrictEqual({ messageKey: 'common:workspaces.errors.genericWithReason', reason: 'name must not contain control characters' })
    expect(workspaceRefusalMessage(new ApiError(500), MEMBER_REFUSALS)).toStrictEqual({ messageKey: 'common:workspaces.errors.generic', reason: null })
    expect(workspaceRefusalMessage(new TypeError('Failed to fetch'), MEMBER_REFUSALS).messageKey).toBe('common:workspaces.errors.generic')
  })
})
