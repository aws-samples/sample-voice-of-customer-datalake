/**
 * @fileoverview One of the supervisor's lines in a thread, in plain words (7.51.04), rendered alone: the workspace's
 * suite reads the run's own (RunWorkspace.test.tsx). Each kind in its words, a failure toned as one, a run of the same
 * health line shown once with how often it was said, the raw text behind Details.
 */
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithQueryClient as render } from '@test/query-client'
import { SupervisorLineView } from './SupervisorLine'
import type { SupervisorLine } from './supervisorLines'
import type { ThreadItem } from '../../../api/engineeringRunWorkspaceApi'

const said = (text: string): ThreadItem => ({
  ref: '1.0.1', at: '2026-11-18T18:30:25Z', kind: 'said', from: { kind: 'harness', id: 'supervisor' }, text, cut: false, update: '', tool: null,
})

const show = (line: SupervisorLine, items: readonly ThreadItem[] = [said('raw')]) =>
  render(<SupervisorLineView line={line} said={items} orchestrator="coordinator-1" />)

describe('a supervisor\'s line', () => {
  it.each([
    [{ kind: 'restarted', agent: 'fixer-3', attempt: 5 }, 'fixer-3 stopped unexpectedly and was restarted (attempt 5)'],
    [{ kind: 'continued', agent: 'fixer-3' }, 'fixer-3 carried on in a new session after its pause'],
    [{ kind: 'failedOut', agent: 'fixer-3', times: 3 }, 'fixer-3 failed 3 times; its task goes to a new agent'],
    [{ kind: 'failedOut', agent: 'coordinator-1', times: 3 }, 'coordinator-1 failed 3 times; the run needs a person'],
    [{ kind: 'notAnswering', agent: 'hunter-2' }, 'hunter-2 stopped responding'],
    [{ kind: 'noRoom', agent: 'hunter-2', times: 4 }, 'No free session for hunter-2 after 4 tries; it waits for a person'],
    [{ kind: 'stopped', sessions: 2 }, 'The run was stopped and its sessions ended (2)'],
  ] satisfies ReadonlyArray<readonly [SupervisorLine, string]>)('says %o as "%s"', (line, words) => {
    show(line)
    expect(screen.getByText(words)).toBeInTheDocument()
  })

  it('counts each status of a health line, a failed one in the danger tone, said several times once', () => {
    show({ kind: 'health', counts: [{ status: 'working', count: 2 }, { status: 'crashed', count: 1 }], costUsd: 1.5 },
      [said('tick 1'), said('tick 2')])
    expect(screen.getByText('At work: 2, Crashed: 1 · $1.50').parentElement).toHaveClass('text-danger')
    expect(screen.getByText('said 2 times')).toBeInTheDocument()
    expect(screen.getByText('Details').nextElementSibling).toHaveTextContent('tick 1 tick 2')
  })
})
