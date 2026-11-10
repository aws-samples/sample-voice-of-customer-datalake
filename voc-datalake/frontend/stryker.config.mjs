// Mutation testing of the SPA: settings in ../scripts/stryker-base.mjs, per-file runs via ../scripts/mutate-ts.sh.
import { strykerConfig } from '../scripts/stryker-base.mjs';

export default strykerConfig({
  mutate: ['src/**/*.{ts,tsx}', '!src/**/*.{spec,test}.{ts,tsx}', '!src/**/*-fixtures.{ts,tsx}', '!src/test/**', '!src/**/*.d.ts'],
  vitestConfig: 'vitest.config.ts',
  ignorePatterns: ['e2e', 'public'],
});
