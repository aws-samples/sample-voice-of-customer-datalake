/**
 * Every server reason the refusal tables (workspaceRefusals.ts) match on, against the value the API assigns or
 * raises, read as TEXT from lambda/shared/workspace_members.py, workspace_plugin_settings.py, platform_workspaces.py,
 * workspace_rename.py, workspace_deletes.py, user_admin_guard.py, lambda/api/users_handler.py and
 * workspaces_handler.py: a module constant (`NAME: Final = '…'`, adjacent string literals joined as Python joins
 * them), an entry of a module's constant dict (`NAME: Final = {'key': '…'}`, one entry a line) or a literal
 * `raise ValidationError('…')`. Only code counts: a reason left in a comment, or changed on one side only, fails here
 * (the page would fall back to the generic message).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BRAND_REFUSALS, DELETE_REFUSALS, DEPLOYMENT_BRAND_REFUSALS, EXPORT_REFUSALS, MEMBER_REFUSALS, PLATFORM_ADMIN_REFUSALS,
  PLATFORM_REFUSALS, PLUGIN_REFUSALS, PLUGIN_NOT_ENABLED, RENAME_REFUSALS,
} from './workspaceRefusals'

const LAMBDA = join(__dirname, '../../../lambda')

const source = (file: string): string => readFileSync(join(LAMBDA, file), 'utf8')

/** The value of the module constant `name` (`NAME: Final = 'a'`, `"a"` or `(\n 'a '\n 'b'\n)`), or null. */
function constant(file: string, name: string): string | null {
  const lines = source(file).split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}: Final = `))
  if (start === -1) return null
  const first = (lines[start] ?? '').slice(`${name}: Final = `.length)
  // A wrapped value runs from `(` to the line whose closing `)` ends it; any other is one line.
  const wrapped = first.startsWith('(') && !first.trimEnd().endsWith(')')
  const end = wrapped ? lines.findIndex((line, index) => index > start && line.trimEnd().endsWith(')')) : start
  const text = [first, ...lines.slice(start + 1, end + 1)].join('\n')
  // Each literal in single or double quotes (a reason with an apostrophe is written in double quotes).
  return [...text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)].map((match) => match[1] ?? match[2] ?? '').join('')
}

/** The text of the entry `'<key>': '…'` (one a line) of the module's constant dict `<name>: Final = {…}`, or null. */
function dictEntry(file: string, name: string, key: string): string | null {
  const lines = source(file).split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}: Final = {`))
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.startsWith('}'))
  const entry = lines.slice(start + 1, end).find((line) => line.trimStart().startsWith(`'${key}': `))
  return entry === undefined ? null : /: '([^'\\]*)'/.exec(entry)?.[1] ?? null
}

/** The literal of `raise <Error>('…')` on a code line (not a comment) whose text starts with `prefix`, or null. */
function raised(file: string, error: string, prefix: string): string | null {
  const line = source(file).split('\n')
    .find((text) => text.trimStart().startsWith(`raise ${error}('${prefix}`))
  return line === undefined ? null : /'([^'\\]*)'/.exec(line)?.[1] ?? null
}

/** Each reason a table names, and where the API holds it. */
const SERVER_REASONS: readonly (readonly [string, string | null])[] = [
  ['workspace_members LAST_ADMIN', constant('shared/workspace_members.py', 'LAST_ADMIN')],
  ['workspace_members CHANGED_MEANWHILE', constant('shared/workspace_members.py', 'CHANGED_MEANWHILE')],
  ['workspace_members ALREADY_MEMBER', constant('shared/workspace_members.py', 'ALREADY_MEMBER')],
  ['workspace_members AMBIGUOUS_EMAIL', constant('shared/workspace_members.py', 'AMBIGUOUS_EMAIL')],
  ['workspace_members EMAIL_ELSEWHERE', constant('shared/workspace_members.py', 'EMAIL_ELSEWHERE')],
  ['workspace_members NO_LONGER_ADMIN', constant('shared/workspace_members.py', 'NO_LONGER_ADMIN')],
  ['workspace_members NEW_ACCOUNT_ADMINS_ONLY', constant('shared/workspace_members.py', 'NEW_ACCOUNT_ADMINS_ONLY')],
  ['workspace_members MEMBER_NOT_FOUND', constant('shared/workspace_members.py', 'MEMBER_NOT_FOUND')],
  ['workspace_plugin_settings PLUGIN_NOT_ENABLED', constant('shared/workspace_plugin_settings.py', 'PLUGIN_NOT_ENABLED')],
  ['workspace_plugin_settings CHANGED_MEANWHILE', constant('shared/workspace_plugin_settings.py', 'CHANGED_MEANWHILE')],
  ['workspace_plugin_settings PLUGIN_NOT_FOUND', constant('shared/workspace_plugin_settings.py', 'PLUGIN_NOT_FOUND')],
  ['platform_workspaces SLUG_TAKEN', constant('shared/platform_workspaces.py', 'SLUG_TAKEN')],
  ['workspace_rename RENAME_CHANGED_MEANWHILE', constant('shared/workspace_rename.py', 'RENAME_CHANGED_MEANWHILE')],
  ['workspace_deletes SLUG_MISMATCH', constant('shared/workspace_deletes.py', 'SLUG_MISMATCH')],
  ['workspace_deletes CHANGED_MEANWHILE', constant('shared/workspace_deletes.py', 'CHANGED_MEANWHILE')],
  ['workspace_deletes HARD_DELETE_DISABLED', constant('shared/workspace_deletes.py', 'HARD_DELETE_DISABLED')],
  ['workspace_deletes NOT_STARTED_FOR_REQUESTER', constant('shared/workspace_deletes.py', 'NOT_STARTED_FOR_REQUESTER')],
  ["workspace_deletes _HELD['export']", dictEntry('shared/workspace_deletes.py', '_HELD', 'export')],
  ["workspace_deletes _HELD['erasure']", dictEntry('shared/workspace_deletes.py', '_HELD', 'erasure')],
  ['user_admin_guard LAST_PLATFORM_ADMIN_MESSAGE', constant('shared/user_admin_guard.py', 'LAST_PLATFORM_ADMIN_MESSAGE')],
  ['workspaces_handler EXPORT_ALREADY_RUNNING', constant('api/workspaces_handler.py', 'EXPORT_ALREADY_RUNNING')],
  ['workspaces_handler EXPORT_ERASURE_RUNNING', constant('api/workspaces_handler.py', 'EXPORT_ERASURE_RUNNING')],
  ['workspaces_handler EXPORT_NOT_DOWNLOADABLE', constant('api/workspaces_handler.py', 'EXPORT_NOT_DOWNLOADABLE')],
  ['users_handler grant to a non-administrator', raised('api/users_handler.py', 'ValidationError', 'Only an administrator can be a platform admin')],
]

// A reason two tables share (NO_LONGER_ADMIN: the members', the plugins' and the rename's writes) counts once.
// The run's refusal (`isPluginNotEnabled`) is matched by its constant, not by a table row.
const tableReasons = [...new Set([
  ...[
    ...MEMBER_REFUSALS, ...PLUGIN_REFUSALS, ...BRAND_REFUSALS, ...DEPLOYMENT_BRAND_REFUSALS, ...PLATFORM_REFUSALS,
    ...PLATFORM_ADMIN_REFUSALS, ...EXPORT_REFUSALS, ...RENAME_REFUSALS, ...DELETE_REFUSALS,
  ].flatMap((row) => (row.reason === undefined ? [] : [row.reason])),
  PLUGIN_NOT_ENABLED,
])]

describe('the refusal tables mirror the API', () => {
  it.each(SERVER_REASONS)('%s is in the API\'s code', (_where, value) => {
    expect(value).not.toBeNull()
  })

  it('the plugins\' writes refuse a demoted admin with the members\' constant', () => {
    expect(source('shared/workspace_plugin_settings.py')).toContain('from shared.workspace_members import NO_LONGER_ADMIN')
  })

  it('the rename refuses a demoted admin with the members\' text (its own constant, or the members\' imported)', () => {
    const imported = source('shared/workspace_rename.py').includes('from shared.workspace_members import NO_LONGER_ADMIN')
    expect(imported || constant('shared/workspace_rename.py', 'NO_LONGER_ADMIN') === constant('shared/workspace_members.py', 'NO_LONGER_ADMIN'))
      .toBe(true)
  })

  it('name exactly the reasons the API assigns or raises, no more and no fewer', () => {
    const byText = (a: string, b: string) => a.localeCompare(b)
    expect([...tableReasons].sort(byText)).toStrictEqual(SERVER_REASONS.map(([, value]) => value ?? '').sort(byText))
  })
})
