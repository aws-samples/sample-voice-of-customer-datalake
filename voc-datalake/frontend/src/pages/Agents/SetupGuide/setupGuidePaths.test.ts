/**
 * @fileoverview The setup guide's addresses (setupGuidePaths.ts): `/agents/setup` is the guide at the step it
 * recommends, `/agents/setup/<step>` a step (snake case written with hyphens); an unknown step or anything after one
 * is replaced by the guide's own path, the query kept; `setup` is never read as an agent's id.
 */
import { describe, expect, it } from 'vitest'
import { agentIdOf, readAgentsAddress } from '../agentsPaths'
import { readSetupGuideAddress, setupGuidePath } from './setupGuidePaths'

const read = (pathname: string, search = '') => readSetupGuideAddress({ pathname, search })

describe('the guide\'s paths', () => {
  it.each([
    ['/agents/setup', null],
    ['/agents/setup/prerequisites', 'prerequisites'],
    ['/agents/setup/bug-fixer', 'bug_fixer'],
    ['/agents/setup/feature-builder', 'feature_builder'],
    ['/agents/setup/ready', 'ready'],
  ])('%s opens %s, as it is', (pathname, step) => {
    expect(read(pathname)).toStrictEqual({ place: step, replaceWith: null })
  })

  it.each([
    ['/agents/setup/deploy', '/agents/setup'],
    ['/agents/setup/bug_fixer', '/agents/setup'],
    ['/agents/setup/triage/extra', '/agents/setup/triage'],
  ])('replaces %s by %s, the query kept', (pathname, to) => {
    expect(read(pathname, '?q=1')?.replaceWith).toStrictEqual({ pathname: to, search: '?q=1' })
  })

  it('builds the links', () => {
    expect([setupGuidePath(), setupGuidePath('bug_fixer'), setupGuidePath('understand')])
      .toStrictEqual(['/agents/setup', '/agents/setup/bug-fixer', '/agents/setup/understand'])
  })

  it('is no other page\'s address, and no page reads it as theirs', () => {
    expect([read('/agents/setupx'), read('/agents')]).toStrictEqual([null, null])
    expect(agentIdOf('/agents/setup/triage')).toBeNull()
    expect(readAgentsAddress({ pathname: '/agents/setup', search: '' })).toBeNull()
  })
})
