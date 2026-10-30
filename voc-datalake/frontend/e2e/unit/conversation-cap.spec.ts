/**
 * Every assistant spec starts a NEW conversation, so each model call's context stays small
 * (owner: well under 100k tokens): the persisted active thread is stripped per spec file
 * (lib/context.ts), and lib/assistant.ts caps the runs one conversation may hold.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { MAX_RUNS_PER_CONVERSATION, countRun, resetRunCount } from '../lib/assistant'
import { PERSISTED_UI_KEYS } from '../lib/context'

const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests')

test('a conversation holds at most MAX_RUNS_PER_CONVERSATION runs until newChat resets it', async ({ page }) => {
  for (let run = 1; run <= MAX_RUNS_PER_CONVERSATION; run += 1) expect(countRun(page)).toBe(run)
  expect(() => countRun(page)).toThrow(/call newChat\(page\) first/)
  resetRunCount(page)
  expect(countRun(page)).toBe(1)
})

test('a new spec never inherits the previous spec\'s active conversation', () => {
  // `voc-assistant-ui` holds activeThreadId (frontend/src/assistant/store/assistantStore.ts).
  expect(PERSISTED_UI_KEYS).toContain('voc-assistant-ui')
})

test('every spec that drives the assistant goes through the capped helpers', () => {
  const offenders = fs.readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => {
      const source = fs.readFileSync(path.join(TESTS_DIR, name), 'utf8')
      const asks = /\b(?:ask|askAssistant|sendOnly|approve|decline)\(page\b/.test(source)
      return asks && !/from '\.\.\/lib\/assistant'/.test(source)
    })
  expect(offenders).toStrictEqual([])
})
