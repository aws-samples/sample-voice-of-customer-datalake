/**
 * @fileoverview The agent the Runs-tab suites render: `ag_1` "Scout" on workflow `wf_1`.
 */
import { normalizeAgent } from '../api/agentsApi'
import type { Agent } from '../api/agentsApi'

export function scoutAgent(): Agent {
  const agent = normalizeAgent({ agent_id: 'ag_1', name: 'Scout', enabled: true, workflow_id: 'wf_1' })
  if (agent === null) throw new Error('fixture agent does not parse')
  return agent
}
