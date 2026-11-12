/**
 * Every server reason the refusal tables (workspaceRefusals.ts) match on, against the value the API assigns or
 * raises, read as TEXT from lambda/shared/workspace_members.py, platform_workspaces.py, user_admin_guard.py and
 * lambda/api/users_handler.py: a module constant (`NAME: Final = '…'`, adjacent string literals joined as Python
 * joins them) or a literal `raise ValidationError('…')`. Only code counts: a reason left in a comment, or changed on
 * one side only, fails here (the page would fall back to the generic message).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEMBER_REFUSALS, PLATFORM_ADMIN_REFUSALS, PLATFORM_REFUSALS } from './workspaceRefusals'

const LAMBDA = join(__dirname, '../../../lambda')

const source = (file: string): string => readFileSync(join(LAMBDA, file), 'utf8')

/** The value of the module constant `name` (`NAME: Final = 'a'` or `NAME: Final = (\n 'a '\n 'b'\n)`), or null. */
function constant(file: string, name: string): string | null {
  const lines = source(file).split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${name}: Final = `))
  if (start === -1) return null
  const first = (lines[start] ?? '').slice(`${name}: Final = `.length)
  // A wrapped value runs from `(` to the line whose closing `)` ends it; any other is one line.
  const wrapped = first.startsWith('(') && !first.trimEnd().endsWith(')')
  const end = wrapped ? lines.findIndex((line, index) => index > start && line.trimEnd().endsWith(')')) : start
  const text = [first, ...lines.slice(start + 1, end + 1)].join('\n')
  return [...text.matchAll(/'([^'\\\n]*)'/g)].map((match) => match[1] ?? '').join('')
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
  ['platform_workspaces SLUG_TAKEN', constant('shared/platform_workspaces.py', 'SLUG_TAKEN')],
  ['user_admin_guard LAST_PLATFORM_ADMIN_MESSAGE', constant('shared/user_admin_guard.py', 'LAST_PLATFORM_ADMIN_MESSAGE')],
  ['users_handler grant to a non-administrator', raised('api/users_handler.py', 'ValidationError', 'Only an administrator can be a platform admin')],
]

const tableReasons = [...MEMBER_REFUSALS, ...PLATFORM_REFUSALS, ...PLATFORM_ADMIN_REFUSALS]
  .flatMap((row) => (row.reason === undefined ? [] : [row.reason]))

describe('the refusal tables mirror the API', () => {
  it.each(SERVER_REASONS)('%s is in the API\'s code', (_where, value) => {
    expect(value).not.toBeNull()
  })

  it('name exactly the reasons the API assigns or raises, no more and no fewer', () => {
    const byText = (a: string, b: string) => a.localeCompare(b)
    expect([...tableReasons].sort(byText)).toStrictEqual(SERVER_REASONS.map(([, value]) => value ?? '').sort(byText))
  })
})
