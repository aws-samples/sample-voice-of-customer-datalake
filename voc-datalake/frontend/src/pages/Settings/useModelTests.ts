/**
 * @fileoverview Model test runs for the Settings AI models card.
 *
 * Keeps the last result per model id for this page visit. `runAll` tests the
 * models ONE AT A TIME (each is a real Bedrock call against the account's
 * quota; a parallel burst would throttle itself and report the wrong thing).
 * A request that fails outright (network, 403, 5xx) is recorded as `error`,
 * so the pill always ends in a result instead of spinning.
 */
import { useCallback, useState } from 'react'
import { api } from '../../api/client'
import { failedModelTestResult } from '../../api/modelTestSchema'
import type { ModelTestResult } from '../../api/modelTestSchema'

export interface ModelTests {
  /** Last result per model id (absent = not tested in this visit). */
  readonly results: Readonly<Partial<Record<string, ModelTestResult>>>
  /** Model ids with a test in flight. */
  readonly testing: ReadonlySet<string>
  /** Progress of the running "Test all" (null when none is running). */
  readonly allProgress: { readonly done: number; readonly total: number } | null
  readonly runTest: (modelId: string) => Promise<ModelTestResult>
  readonly runAll: (modelIds: readonly string[]) => Promise<void>
}

export function useModelTests(): ModelTests {
  const [results, setResults] = useState<Partial<Record<string, ModelTestResult>>>({})
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set())
  const [allProgress, setAllProgress] = useState<ModelTests['allProgress']>(null)

  const runTest = useCallback(async (modelId: string) => {
    setTesting((current) => new Set(current).add(modelId))
    const result = await api.testModel(modelId).catch(() => failedModelTestResult(modelId))
    setResults((current) => ({ ...current, [modelId]: result }))
    setTesting((current) => {
      const next = new Set(current)
      next.delete(modelId)
      return next
    })
    return result
  }, [])

  const runAll = useCallback(async (modelIds: readonly string[]) => {
    const total = modelIds.length
    try {
      for (const [done, modelId] of modelIds.entries()) {
        setAllProgress({ done, total })
        // Sequential by design — see the module comment.
        await runTest(modelId)
      }
    } finally {
      setAllProgress(null)
    }
  }, [runTest])

  return { results, testing, allProgress, runTest, runAll }
}
