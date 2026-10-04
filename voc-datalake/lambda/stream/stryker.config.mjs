// Mutation testing (scripts/mutation-report.sh at the repo root). A report you act on, not a gate:
// `break: null` on purpose.
export default {
  testRunner: 'vitest',
  mutate: ['src/**/*.ts', '!src/**/*.{spec,test}.ts', '!src/**/*-fixtures.ts', '!src/**/__fixtures__/**', '!src/**/*.d.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress'],
  clearTextReporter: { allowColor: false, reportTests: false },
  tempDirName: '.stryker-tmp',
  timeoutMS: 20000,
  timeoutFactor: 2,
  thresholds: { high: 100, low: 0, break: null },
};
