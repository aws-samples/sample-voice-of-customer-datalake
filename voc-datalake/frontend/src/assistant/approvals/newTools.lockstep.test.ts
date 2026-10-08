/**
 * LOCKSTEP: the memory / agents / company approval schemas of the SPA
 * (memorySchemas, agentSchemas, companySchemas, api/workflowsApi, api/agentsApi)
 * must accept exactly what the stream Lambda's client tools propose
 * (`lambda/stream/src/assistant/tools/{client/memory.ts, client/company.ts,
 * agent-schemas.ts}` + `server/memory-shape.ts`).
 *
 * The stream package cannot be imported (separate npm package, zod 3), so its
 * source is read as TEXT — like allowlists.lockstep.test.ts — and its literal
 * enums and limits are compared with the SPA's.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_MEMORY_STATEMENT, MEMORY_KINDS, MEMORY_RESOLVE_ACTIONS, MEMORY_RETENTIONS, MEMORY_SCOPES, mergeMemoriesArgs,
} from './memorySchemas'
import { STREAM_AGENT_LIMITS, STREAM_WORKFLOW_LIMITS } from './agentSchemas'
import { COMPANY_LIMITS } from './companySchemas'
import {
  WORKFLOW_EDGE_LABELS, WORKFLOW_LOOP_UNTIL, WORKFLOW_NODE_ROLES, WORKFLOW_NODE_TYPES, WORKFLOW_SCHEMA,
} from '../../api/workflowsApi'
import { AGENT_MODEL_ROLES, AGENT_SCHEDULE_EVERY, AGENT_THRESHOLD_PER, AGENT_VISIBILITIES } from '../../api/agentsApi'
import { at } from '@test/defined'

const TOOLS = join(__dirname, '../../../../lambda/stream/src/assistant/tools')
const read = (file: string) => readFileSync(join(TOOLS, file), 'utf8')
const memory = read('client/memory.ts')
const memoryShape = read('server/memory-shape.ts')
const company = read('client/company.ts')
const agentSchemas = read('agent-schemas.ts')

/** The quoted strings of `[export ]const NAME = [ ... ] as const`. */
function list(source: string, name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const`).exec(source)
  if (match === null) throw new Error(`${name} array literal not found`)
  return [...at(match, 1).matchAll(/'([^']+)'/g)].map((m) => at(m, 1))
}

/** `[export ]const NAME = { key: 123, ... } as const` → record. */
function numbers(source: string, name: string): Record<string, number> {
  const match = new RegExp(`const ${name} = \\{([^}]*)\\} as const`).exec(source)
  if (match === null) throw new Error(`${name} object literal not found`)
  return Object.fromEntries([...at(match, 1).matchAll(/\b(\w+):\s*([\d_]+)/g)].map((m): [string, number] => [at(m, 1), Number(at(m, 2).replaceAll('_', ''))]))
}

/** `const NAME = 123;` → 123. */
function scalar(source: string, name: string): number {
  const match = new RegExp(`const ${name} = ([\\d_]+);`).exec(source)
  if (match === null) throw new Error(`${name} not found`)
  return Number(at(match, 1).replaceAll('_', ''))
}

/** The SPA limits restricted to the keys the stream declares (the SPA may carry extra builder switches). */
const pickKeys = (spa: object, keys: readonly string[]) => Object.fromEntries(Object.entries(spa).filter(([k]) => keys.includes(k)))

describe('new client tools lockstep (stream ⇄ SPA)', () => {
  it('memory: the same scopes, kinds, retentions, resolve actions and statement limit', () => {
    expect(list(memoryShape, 'MEMORY_SCOPES')).toStrictEqual([...MEMORY_SCOPES])
    expect(list(memoryShape, 'MEMORY_KINDS')).toStrictEqual([...MEMORY_KINDS])
    expect(list(memoryShape, 'MEMORY_RETENTIONS')).toStrictEqual([...MEMORY_RETENTIONS])
    expect(list(memory, 'MEMORY_RESOLVE_ACTIONS')).toStrictEqual([...MEMORY_RESOLVE_ACTIONS])
  })

  it('memory: the same numeric limits', () => {
    expect(scalar(memoryShape, 'MAX_MEMORY_STATEMENT')).toBe(MAX_MEMORY_STATEMENT)
    const maxMerge = scalar(memory, 'MAX_MERGE_IDS')
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `mem_${i}`)
    expect(mergeMemoriesArgs.safeParse({ memory_ids: ids(maxMerge), statement: 's' }).success).toBe(true)
    expect(mergeMemoriesArgs.safeParse({ memory_ids: ids(maxMerge + 1), statement: 's' }).success).toBe(false)
  })

  it('company: the same limits', () => {
    expect(numbers(company, 'COMPANY_LIMITS')).toStrictEqual({ ...COMPANY_LIMITS })
    expect(list(company, 'OBJECTIVE_HORIZONS')).toStrictEqual(['long', 'quarter', 'date'])
  })

  it('workflow: the same schema id and node types', () => {
    expect(new RegExp(`WORKFLOW_SCHEMA_VERSION = '${WORKFLOW_SCHEMA}'`).test(agentSchemas)).toBe(true)
    expect(list(agentSchemas, 'WORKFLOW_NODE_TYPES')).toStrictEqual([...WORKFLOW_NODE_TYPES])
  })

  it('workflow: the same roles, edge labels and loop conditions', () => {
    expect(list(agentSchemas, 'WORKFLOW_NODE_ROLES')).toStrictEqual([...WORKFLOW_NODE_ROLES])
    expect(list(agentSchemas, 'WORKFLOW_EDGE_LABELS')).toStrictEqual([...WORKFLOW_EDGE_LABELS])
    expect(list(agentSchemas, 'WORKFLOW_LOOP_UNTIL')).toStrictEqual([...WORKFLOW_LOOP_UNTIL])
  })

  it('workflow + agent: the approval boundary uses the stream limits', () => {
    expect(numbers(agentSchemas, 'WORKFLOW_LIMITS')).toStrictEqual({ ...STREAM_WORKFLOW_LIMITS })
    const agentLimits = numbers(agentSchemas, 'AGENT_LIMITS')
    expect(pickKeys(STREAM_AGENT_LIMITS, Object.keys(agentLimits))).toStrictEqual(agentLimits)
  })

  it('agent: the same trigger, visibility and model-role enums', () => {
    expect(list(agentSchemas, 'AGENT_SCHEDULE_EVERY')).toStrictEqual([...AGENT_SCHEDULE_EVERY])
    expect(list(agentSchemas, 'AGENT_THRESHOLD_PER')).toStrictEqual([...AGENT_THRESHOLD_PER])
    expect(list(agentSchemas, 'AGENT_VISIBILITIES')).toStrictEqual([...AGENT_VISIBILITIES])
    expect(list(agentSchemas, 'AGENT_MODEL_ROLES')).toStrictEqual([...AGENT_MODEL_ROLES])
  })

  it('agent: the builder switches the stream schema hard-codes', () => {
    // budget.max_model_calls_per_run is `.min(1)` and monthly_call_cap is not nullable on the stream side.
    expect(/max_model_calls_per_run: z\.number\(\)\.int\(\)\.min\(1\)/.test(agentSchemas)).toBe(true)
    expect(/monthly_call_cap: z\.number\(\)\.int\(\)\.min\(0\)\.max\(AGENT_LIMITS\.maxMonthlyCallCap\),/.test(agentSchemas)).toBe(true)
    expect([STREAM_AGENT_LIMITS.minModelCallsPerRun, STREAM_AGENT_LIMITS.monthlyCapNullable]).toStrictEqual([1, false])
  })
})
