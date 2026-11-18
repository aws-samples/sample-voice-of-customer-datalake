/**
 * @fileoverview The `api/client` double the AI models specs share (AiModelSection.test.tsx,
 * AiModelSection.webSearch.test.tsx): the model settings read and save, and a model's Test, each a spy a spec
 * answers; the capacity read answers no models.
 *
 *   vi.mock('../../api/client', () => import('./ai-model-section-fixtures').then((m) => m.modelClientModule()))
 */
import { vi } from 'vitest'
import type { ModelTestResult } from '../../api/modelTestSchema'

export const modelApi = {
  getModelSettings: vi.fn<() => Promise<unknown>>(),
  saveModelSettings: vi.fn<(surface: string, modelId: string | null) => Promise<unknown>>(),
  testModel: vi.fn<(modelId: string) => Promise<ModelTestResult>>(),
}

export function modelClientModule() {
  return {
    api: {
      getModelSettings: () => modelApi.getModelSettings(),
      saveModelSettings: (surface: string, modelId: string | null) => modelApi.saveModelSettings(surface, modelId),
      testModel: (modelId: string) => modelApi.testModel(modelId),
      getModelCapacity: () => Promise.resolve({ models: [], image: null }),
    },
  }
}
