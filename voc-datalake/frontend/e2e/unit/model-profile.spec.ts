/** Setup's e2e group check (lib/modelProfile.ts): a test user outside `e2e` stops the run before any model call. */
import { expect, test } from '@playwright/test'
import { addToGroupCommand, missingE2eGroup, requireE2eGroup } from '../lib/modelProfile'

test('a user in the e2e group passes', () => {
  expect(missingE2eGroup('admin', 'e2e-admin', ['admins', 'e2e'])).toBeNull()
  expect(() => requireE2eGroup('user', 'e2e-user', ['users', 'e2e'], {})).not.toThrow()
})

test('a user outside it fails fast with the admin command to fix it', () => {
  expect(() => requireE2eGroup('user', 'e2e-user', ['users'], {})).toThrow(/not in the Cognito group "e2e"/)
  expect(missingE2eGroup('user', 'e2e-user', [])).toContain(addToGroupCommand('e2e-user'))
  expect(addToGroupCommand('e2e-user')).toBe(
    "aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username 'e2e-user' --group-name e2e")
})

test('E2E_ALLOW_FULL_MODELS=1 turns the failure into a warning', () => {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message: string) => { warnings.push(message) }
  try {
    expect(() => requireE2eGroup('admin', 'e2e-admin', ['admins'], { E2E_ALLOW_FULL_MODELS: '1' })).not.toThrow()
  } finally {
    console.warn = original
  }
  expect(warnings.join('\n')).toMatch(/WARNING: The admin test user is not in the Cognito group/)
})
