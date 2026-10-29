/**
 * @fileoverview Keeps `API_WORKFLOW_LIMITS` (the workflow editor's bounds) in step
 * with the `MAX_*` / `MIN_*` constants of `lambda/shared/workflow_schema.py`, the
 * validator every workflow save goes through. The two JSON-size bounds compare a
 * character count with the server's UTF-8 byte count: equal for ASCII, so the SPA
 * is never stricter than the server.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_WORKFLOW_LIMITS, type WorkflowLimits } from './workflowsApi'

const SCHEMA = readFileSync(join(__dirname, '../../../lambda/shared/workflow_schema.py'), 'utf8')

const constant = (name: string) => {
  const text = new RegExp(`^${name}: Final = ([\\d_]+)$`, 'm').exec(SCHEMA)?.[1]
  return text === undefined ? Number.NaN : Number(text.replace(/_/g, ''))
}

const FROM_BACKEND: Record<keyof WorkflowLimits, number> = {
  maxNodes: constant('MAX_NODES'),
  maxEdges: constant('MAX_EDGES'),
  maxLoops: constant('MAX_LOOPS'),
  minRounds: constant('MIN_ROUNDS'),
  maxRounds: constant('MAX_ROUNDS'),
  maxNameChars: constant('MAX_NAME_CHARS'),
  maxDescriptionChars: constant('MAX_DESCRIPTION_CHARS'),
  maxTitleChars: constant('MAX_TITLE_CHARS'),
  maxInstructionsChars: constant('MAX_NODE_INSTRUCTIONS_CHARS'),
  maxParamsJsonChars: constant('MAX_PARAMS_BYTES'),
  maxDefinitionJsonChars: constant('MAX_DEFINITION_BYTES'),
}

describe('API_WORKFLOW_LIMITS', () => {
  it('equals the bounds lambda/shared/workflow_schema.py enforces', () => {
    for (const value of Object.values(FROM_BACKEND)) expect(value).not.toBeNaN()
    expect({ ...API_WORKFLOW_LIMITS }).toStrictEqual(FROM_BACKEND)
  })
})
