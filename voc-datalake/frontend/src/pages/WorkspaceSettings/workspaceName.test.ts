/** A workspace name's own checks: the server's rules (1 to 80 code points once trimmed, no control character). */
import { describe, expect, it } from 'vitest'
import { workspaceNameProblem } from './workspaceName'

describe('workspaceNameProblem', () => {
  it.each<[string, string, ReturnType<typeof workspaceNameProblem>]>([
    ['a name', 'Acme Outfitters', null],
    ['a name with spaces around it (trimmed)', '  Acme Outfitters  ', null],
    ['80 characters', 'a'.repeat(80), null],
    ['80 code points the browser counts as 160', '🏔'.repeat(80), null],
    ['nothing', '', 'length'],
    ['spaces only', '   ', 'length'],
    ['81 characters', 'a'.repeat(81), 'length'],
    ['a tab', 'Acme\tOutfitters', 'control'],
    ['a C1 control character', 'Acme\u0085Outfitters', 'control'],
  ])('%s', (_case, name, problem) => {
    expect(workspaceNameProblem(name)).toBe(problem)
  })
})
