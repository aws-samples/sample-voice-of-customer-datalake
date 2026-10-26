/**
 * @fileoverview Every editor under the shared unsaved-changes guard runs the
 * shared Cancel-keeps-the-draft contract (3.00.00 R2).
 *
 * R2 slipped through because each editor's spec tested Cancel its own way and
 * /admin never let data land while the dialog was open. This scans the app
 * sources for every module that mounts the guard and fails when no spec that
 * calls `expectCancelKeepsDraftGuarded` names it, so a new guarded editor
 * cannot ship without the contract.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}'], { query: '?raw', import: 'default', eager: true })
const specs = import.meta.glob('../../**/*.test.{ts,tsx}', { query: '?raw', import: 'default', eager: true })

const textEntries = (files: Record<string, unknown>): Array<[string, string]> =>
  Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string')

/** A call (not the definition) of one of the guard hooks. */
const GUARD_CALL = /\b(?:useUnsavedChangesGuard|useSnapshotGuard|useDraftGuard)\(\{/
/** The guard's own modules define (or wrap) the hooks; they are not editors. */
const GUARD_IMPLEMENTATION: ReadonlySet<string> = new Set(['useUnsavedChangesGuard', 'useSnapshotGuard', 'useDraft'])

const moduleName = (path: string): string => path.replace(/^.*\//, '').replace(/\.tsx?$/, '')

const guardedModules = textEntries(sources)
  .filter(([path, text]) => GUARD_CALL.test(text) && !GUARD_IMPLEMENTATION.has(moduleName(path)))
  .map(([path]) => path)

const contractSpecs = textEntries(specs).filter(([path, text]) =>
  text.includes('expectCancelKeepsDraftGuarded(') && !path.endsWith('/guardedEditors.test.ts'))

describe('every guarded editor runs the shared Cancel contract', () => {
  it('finds the guarded editors it audits (the scan is not vacuous)', () => {
    expect(guardedModules.map(moduleName)).toStrictEqual(expect.arrayContaining([
      'Settings', 'AgentDetail', 'CompanyContextSection', 'FormEditor', 'WorkflowEditor',
    ]))
    expect(guardedModules.length).toBeGreaterThanOrEqual(12)
  })

  it.each(guardedModules.map((path) => [moduleName(path), path]))('%s has a contract spec', (name) => {
    const word = new RegExp(`\\b${name}\\b`)
    const covering = contractSpecs.filter(([, text]) => word.test(text)).map(([path]) => path)
    expect(covering, `${name} mounts the unsaved-changes guard but no spec runs expectCancelKeepsDraftGuarded on it`).not.toStrictEqual([])
  })
})
