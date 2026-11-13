/**
 * @fileoverview The deployment's engineering module (config.json `features.engineering`) as a test sets it: mock
 * `runtimeConfig` with {@link runtimeConfigModule} and flip {@link engineeringModule}`.available`.
 *
 *     vi.mock('../../runtimeConfig', (importOriginal) =>
 *       import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))
 *
 * @module test/engineeringModule
 */

/** Whether the mocked deployment has the engineering module (each suite sets it in its `beforeEach`). */
export const engineeringModule = { available: false }

type RuntimeConfig = typeof import('../runtimeConfig')

/** The real `runtimeConfig`, with `isEngineeringAvailable` reading {@link engineeringModule}. */
export async function runtimeConfigModule(importOriginal: <T>() => Promise<T>): Promise<RuntimeConfig> {
  const original = await importOriginal<RuntimeConfig>()
  return { ...original, isEngineeringAvailable: () => engineeringModule.available }
}
