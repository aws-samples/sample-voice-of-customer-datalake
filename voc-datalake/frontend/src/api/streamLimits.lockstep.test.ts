/**
 * @fileoverview Pins the client-side stream limits to the server's own numbers.
 *
 * `streamLimits.ts` duplicates values the stream Lambda enforces, because that
 * Lambda is a separate package the frontend build cannot import from. Duplicated
 * constants rot silently, and the failure mode is the one this whole change set
 * exists to remove: the UI lets a request through and the user gets an opaque
 * `Stream error: 400`. So this test reads the schema source and compares.
 *
 * Precedent: lambda/api/test/test_feedback_page_limit_lockstep.py does the same
 * across the Python/TypeScript boundary.
 *
 * @module api/streamLimits.lockstep.test
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_CHAT_MESSAGE_LENGTH, MAX_SELECTED_PERSONAS } from './streamLimits'

// Relative to the frontend package root, which is where vitest runs. A literal
// because the security lint rule forbids a computed argument.
// (import.meta.url is not usable here: it is not a file: URL under this config.)
const SCHEMA_PATH = '../lambda/stream/src/schema.ts'

/**
 * Deliberately NOT skipped when the sibling package is absent. A skipped lockstep
 * is a silent lockstep, and silence is the failure this test exists to prevent —
 * so an unreachable schema is still a failure, just one that explains itself
 * instead of surfacing as a bare ENOENT.
 */
function readSchemaSource(): string {
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(
      `Cannot read ${SCHEMA_PATH} from ${process.cwd()}. This test pins the frontend's `
      + 'copy of the stream request limits against the stream Lambda\'s own schema, so it '
      + 'needs both packages checked out and must run from the frontend package root.',
    )
  }
  return readFileSync(SCHEMA_PATH, 'utf8')
}

const SCHEMA_SOURCE = readSchemaSource()

/**
 * Reads `const NAME = 1_234;` out of the schema source, tolerating the numeric
 * separators the stream package uses. Throws rather than returning a default: a
 * renamed constant must fail this test, not silently satisfy it.
 */
function serverConstant(name: string): number {
  const match = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(SCHEMA_SOURCE)
  if (match?.[1] === undefined) {
    throw new Error(`${name} not found in the stream schema source — was it renamed or moved?`)
  }
  return Number(match[1].replaceAll('_', ''))
}

describe('stream limits lockstep', () => {
  it('reads the schema source it is meant to be pinned against', () => {
    // Guards the guard: an empty or wrong file would make every assertion below
    // vacuous, and the regexes would just throw with a confusing message.
    expect(SCHEMA_SOURCE).toContain('export const chatRequestSchema')
  })

  it('mirrors the server message cap', () => {
    expect(MAX_CHAT_MESSAGE_LENGTH).toBe(serverConstant('MAX_MESSAGE_LENGTH'))
  })

  it('mirrors the server persona array cap', () => {
    expect(MAX_SELECTED_PERSONAS).toBe(serverConstant('MAX_PERSONAS_DOCS_ARRAY'))
  })

  it('fails loudly when a server constant is renamed rather than defaulting', () => {
    expect(() => serverConstant('MAX_CONSTANT_THAT_DOES_NOT_EXIST')).toThrow(/not found/)
  })
})
