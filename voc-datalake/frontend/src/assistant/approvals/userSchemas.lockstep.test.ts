/**
 * LOCKSTEP: the user-administration approval boundary (./userSchemas) ⇄ the
 * stream Lambda's (`lambda/stream/src/assistant/tools/client/user-schemas.ts`)
 * ⇄ the routes that store users and grants (`lambda/api/users_handler.py`,
 * `lambda/shared/category_access.py`, `category_config.py`, the source-profile
 * id rule). The argument shapes and constants are compared through a direct
 * import of the stream module; the Python bounds are read as TEXT. A bound
 * accepted by one side only would mean a card the server proposes but the SPA
 * refuses — or a save the route rejects after the user approved it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCESS_WILDCARD, CATEGORY_NAME_PATTERN, SPA_USER_LIMITS, USERNAME_PATTERN, USER_ROLES,
  createUserArgs, setUserAccessArgs, updateUserArgs,
} from './userSchemas'
import { at } from '@test/defined'
// Self-contained (zod only, same major), like the connector lockstep's direct import.
import * as streamSchemas from '../../../../lambda/stream/src/assistant/tools/client/user-schemas'
import { SOURCE_ID_RE } from '../../api/sourceProfilesApi'

const ROOT = join(__dirname, '../../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const usersHandler = read('lambda/api/users_handler.py')
const projectAccess = read('lambda/shared/project_access.py')
const categoryAccess = read('lambda/shared/category_access.py')
const categoryConfig = read('lambda/shared/category_config.py')
const sourceProfiles = read('lambda/shared/source_profiles.py')

/** `NAME: Final = <int>` in a Python module. */
function pythonFinalInt(source: string, name: string): number {
  const match = new RegExp(`^${name}: Final = (\\d+)$`, 'm').exec(source)
  if (match === null) throw new Error(`${name} not found`)
  return Number(at(match, 1))
}

/** `NAME: Final = '<text>'` in a Python module. */
function pythonFinalString(source: string, name: string): string {
  const match = new RegExp(`^${name}: Final = '([^']*)'$`, 'm').exec(source)
  if (match === null) throw new Error(`${name} not found`)
  return at(match, 1)
}

const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b))
const shapeKeys = (schema: { shape: Record<string, unknown> }) => sorted(Object.keys(schema.shape))

describe('user tools: stream ⇄ SPA', () => {
  it('the same limits, roles and wildcard', () => {
    expect({ ...streamSchemas.USER_LIMITS }).toStrictEqual({ ...SPA_USER_LIMITS })
    expect([...streamSchemas.USER_ROLES]).toStrictEqual([...USER_ROLES])
    expect(streamSchemas.ACCESS_WILDCARD).toBe(ACCESS_WILDCARD)
  })

  it('the same patterns', () => {
    expect(streamSchemas.USERNAME_PATTERN.source).toBe(USERNAME_PATTERN.source)
    expect(streamSchemas.SOURCE_ID_PATTERN.source).toBe(SOURCE_ID_RE.source)
    expect(streamSchemas.CATEGORY_NAME_PATTERN.source).toBe(CATEGORY_NAME_PATTERN.source)
  })

  it('the three argument shapes take exactly the stream\u2019s fields', () => {
    expect(shapeKeys(createUserArgs)).toStrictEqual(shapeKeys(streamSchemas.createUserArgsSchema))
    expect(shapeKeys(updateUserArgs)).toStrictEqual(shapeKeys(streamSchemas.updateUserArgsSchema))
    expect(shapeKeys(updateUserArgs.shape.updates)).toStrictEqual(shapeKeys(streamSchemas.updateUserArgsSchema.shape.updates))
    expect(shapeKeys(setUserAccessArgs)).toStrictEqual(shapeKeys(streamSchemas.setUserAccessArgsSchema))
  })
})

describe('user tools: SPA ⇄ the routes', () => {
  it('the roles are the ones users_handler.py accepts', () => {
    // ROLE_GROUPS = (ADMIN_GROUP, USER_GROUP); ADMIN_GROUP lives in shared/project_access.py.
    expect([...USER_ROLES]).toStrictEqual([
      pythonFinalString(projectAccess, 'ADMIN_GROUP'), pythonFinalString(usersHandler, 'USER_GROUP'),
    ])
    expect(usersHandler).toMatch(/^ROLE_GROUPS: Final = \(ADMIN_GROUP, USER_GROUP\)$/m)
    expect(usersHandler).toContain('if group not in ROLE_GROUPS')
  })

  it('the grant caps are category_access.py\u2019s and the category name cap is category_config.py\u2019s', () => {
    expect(SPA_USER_LIMITS.maxCategories).toBe(pythonFinalInt(categoryAccess, 'MAX_ACCESS_CATEGORIES'))
    expect(SPA_USER_LIMITS.maxSources).toBe(pythonFinalInt(categoryAccess, 'MAX_ACCESS_SOURCES'))
    expect(SPA_USER_LIMITS.maxCategoryNameLength).toBe(pythonFinalInt(categoryConfig, 'MAX_NAME_CHARS'))
    expect(/^WILDCARD: Final = '\*'$/m.test(categoryAccess)).toBe(true)
  })

  it('the source id rule is the source profiles\u2019 (Python spells the anchor \\Z)', () => {
    const python = /SOURCE_ID_RE: Final = re\.compile\(r'([^']+)'\)/.exec(sourceProfiles)
    expect(at(python ?? [], 1)).toBe(SOURCE_ID_RE.source.replace(/\$$/, '\\Z'))
  })

  it('the per-entry caps are the ones the patterns encode', () => {
    expect(USERNAME_PATTERN.source).toContain(`{1,${String(SPA_USER_LIMITS.maxUsernameLength)}}`)
    expect(CATEGORY_NAME_PATTERN.source).toContain(`{1,${String(SPA_USER_LIMITS.maxCategoryNameLength)}}`)
    expect(SOURCE_ID_RE.source).toContain(`{0,${String(SPA_USER_LIMITS.maxSourceIdLength - 1)}}`)
  })
})

describe('user tools: the SPA boundary itself', () => {
  const user = { username: 'c1d2e3f4-0000-4000-8000-000000000000' }

  it.each([
    ['exactly one @ with text on both sides', 'alice@example.com', true],
    ['no @', 'alice.example.com', false],
    ['two @', 'a@b@example.com', false],
    ['empty local part', '@example.com', false],
    ['empty domain', 'alice@', false],
    ['inner whitespace', 'ali ce@example.com', false],
    ['over the length cap', `${'a'.repeat(SPA_USER_LIMITS.maxEmailLength)}@x.y`, false],
  ])('create_user email: %s', (_label, email, ok) => {
    expect(createUserArgs.safeParse({ email, role: 'users' }).success).toBe(ok)
  })

  it('create_user requires the role and refuses unknown keys and blank names', () => {
    expect(createUserArgs.safeParse({ email: 'a@b.co' }).success).toBe(false)
    expect(createUserArgs.safeParse({ email: 'a@b.co', role: 'owners' }).success).toBe(false)
    expect(createUserArgs.safeParse({ email: 'a@b.co', role: 'users', given_name: '   ' }).success).toBe(false)
    expect(createUserArgs.safeParse({ email: 'a@b.co', role: 'users', sub: 'x' }).success).toBe(false)
  })

  it('update_user needs at least one update and only the editable fields', () => {
    expect(updateUserArgs.safeParse({ ...user, updates: {} }).success).toBe(false)
    expect(updateUserArgs.safeParse({ ...user, updates: { email: 'new@example.com' } }).success).toBe(false)
    expect(updateUserArgs.safeParse({ username: 'not a username', updates: { enabled: false } }).success).toBe(false)
    expect(updateUserArgs.safeParse({ ...user, updates: { given_name: 'A', role: 'admins', enabled: false } }).success).toBe(true)
  })

  it.each([
    ['the wildcard alone', [ACCESS_WILDCARD], undefined, true],
    ['names', ['delivery', 'billing'], ['web', 'ios_app'], true],
    ['the default source rule', ['delivery'], null, true],
    ['the wildcard mixed with names', [ACCESS_WILDCARD, 'delivery'], undefined, false],
    ['a repeated name', ['delivery', 'delivery'], undefined, false],
    ['a name with whitespace', ['late delivery'], undefined, false],
    ['no category at all', [], undefined, false],
    ['too many categories', Array.from({ length: SPA_USER_LIMITS.maxCategories + 1 }, (_, i) => `c${String(i)}`), undefined, false],
    ['an upper-case source id', ['delivery'], ['Web'], false],
    ['the source wildcard mixed with ids', ['delivery'], [ACCESS_WILDCARD, 'web'], false],
  ])('set_user_access: %s', (_label, categories, sources, ok) => {
    expect(setUserAccessArgs.safeParse({ ...user, categories, sources }).success).toBe(ok)
  })
})
