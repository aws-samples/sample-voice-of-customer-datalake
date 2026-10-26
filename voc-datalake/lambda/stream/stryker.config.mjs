// Mutation testing of the AI assistant Lambda: settings in ../../scripts/stryker-base.mjs, per-file runs via
// ../../scripts/mutate-ts.sh.
import { strykerConfig } from '../../scripts/stryker-base.mjs';

export default strykerConfig({
  mutate: ['src/**/*.ts', '!src/**/*.{spec,test}.ts', '!src/**/*-fixtures.ts', '!src/**/__fixtures__/**', '!src/**/*.d.ts'],
  vitestConfig: 'vitest.config.ts',
});
