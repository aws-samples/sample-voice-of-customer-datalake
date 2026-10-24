// Mutation testing of the CDK app (bin/, lib/): settings in scripts/stryker-base.mjs, per-file runs via
// scripts/mutate-ts.sh. frontend/ and lambda/stream/ are packages of their own with their own config.
import { strykerConfig } from './scripts/stryker-base.mjs';

export default strykerConfig({
  mutate: ['bin/**/*.ts', 'lib/**/*.ts', '!lib/**/*.test.ts', '!lib/**/*-fixtures.ts', '!lib/test-support/**', '!**/*.d.ts'],
  vitestConfig: 'vitest.config.ts',
  ignorePatterns: ['frontend', 'lambda/stream', 'lambda/layers', 'plugins/**/node_modules'],
});
