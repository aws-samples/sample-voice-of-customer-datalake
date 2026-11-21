/**
 * @fileoverview The `api/client` double the AI models specs share (AiModelSection.test.tsx,
 * AiModelSection.webSearch.test.tsx, AiModelSection.customModels.test.tsx): the model settings read and save, and a
 * model's Test (a custom model's check with its probe), each a spy a spec answers; the capacity read answers no
 * models. Also the lookup of a surface's row by its select's label.
 *
 *   vi.mock('../../api/client', () => import('./ai-model-section-fixtures').then((m) => m.modelClientModule()))
 */
import { screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { ModelTestProbe, ModelTestResult } from '../../api/modelTestSchema'

export const modelApi = {
  getModelSettings: vi.fn<() => Promise<unknown>>(),
  saveModelSettings: vi.fn<(surface: string, modelId: string | null) => Promise<unknown>>(),
  testModel: vi.fn<(modelId: string, probe?: ModelTestProbe) => Promise<ModelTestResult>>(),
}

export function modelClientModule() {
  return {
    api: {
      getModelSettings: () => modelApi.getModelSettings(),
      saveModelSettings: (surface: string, modelId: string | null) => modelApi.saveModelSettings(surface, modelId),
      // A basic test reaches the spy with the model id alone (as before 7.65.00's checks); a check adds its probe.
      testModel: (modelId: string, probe?: ModelTestProbe) =>
        (probe === undefined || probe === 'basic' ? modelApi.testModel(modelId) : modelApi.testModel(modelId, probe)),
      getModelCapacity: () => Promise.resolve({ models: [], image: null }),
    },
  }
}

/** The surface row (`[data-surface]`) holding the select labelled `label`. */
export function surfaceRowOf(label: string): HTMLElement {
  const row = screen.getByLabelText(label).closest<HTMLElement>('[data-surface]')
  if (!row) throw new Error(`no row for ${label}`)
  return row
}
