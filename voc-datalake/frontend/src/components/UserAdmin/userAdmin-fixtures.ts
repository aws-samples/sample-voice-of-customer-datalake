/**
 * @fileoverview Fixtures shared by the UserAdmin specs.
 */
import type { CognitoUser } from '../../api/types'

/** A confirmed, enabled member of `users` with no name; override what the case is about. */
export function cognitoUser(overrides: Partial<CognitoUser> = {}): CognitoUser {
  return {
    username: 'user1',
    email: 'test@example.com',
    name: '',
    given_name: '',
    family_name: '',
    status: 'CONFIRMED',
    enabled: true,
    groups: ['users'],
    created_at: null,
    last_modified: null,
    ...overrides,
  }
}
