import tseslint from 'typescript-eslint'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import sonarjs from 'eslint-plugin-sonarjs'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'mock-server.js',
      '**/*.test.ts',
      // #374 argues that an asset survived in `public/` because no gate read it.
      // The guard that now reads `public/` is itself a `*.test.ts`, so shipping
      // it under this ignore would repeat the finding it exists to prevent. One
      // negated path rather than un-ignoring every test file: the rest of the
      // suite carries a backlog whose cleanup is not this change.
      '!src/publicAssets.test.ts',
      '**/*.test.tsx',
      'src/test/**/*',
      'vitest.config.ts',
    ],
  },
  ...tseslint.configs.recommended,
  eslintComments.recommended,
  {
    rules: {
      '@eslint-community/eslint-comments/no-use': [
        'error',
        { allow: ['eslint-disable', 'eslint-enable', 'eslint-disable-next-line'] },
      ],
    },
  },
  sonarjs.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Comments policy
      'no-warning-comments': 'off',
      'multiline-comment-style': 'off',
      'capitalized-comments': 'off',
      'no-inline-comments': 'off',
      'spaced-comment': 'off',
      // Ban let - use const only
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclaration[kind="let"]',
          message: 'Use const. Avoid mutation.',
        },
      ],
      'prefer-const': 'error',
      'no-var': 'error',
      // No any types
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      // No type assertions - fix the types instead
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'never' },
      ],
      // No non-null assertions
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Complexity limits
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 3],
      complexity: ['error', 12],
      // Naming conventions
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'parameter',
          format: ['camelCase', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase'],
        },
        {
          selector: ['objectLiteralProperty', 'typeProperty'],
          format: null,
        },
      ],
    },
  },
  {
    // The un-ignored guard (see the negated pattern above) is the one linted file
    // that `tsconfig.app.json` excludes, so the project service cannot type it and
    // every type-aware rule would report a parse error instead of a finding. Point
    // it at `tsconfig.test.json`, which does include `src/**/*.test.ts`, rather
    // than widening the app project to cover tests.
    //
    // It also runs in node, not a browser: it shells out to `git` and reads
    // `__dirname`.
    //
    // ⚠️ This buys LINT coverage, not typecheck coverage. `npm run typecheck` runs
    // against `tsconfig.app.json`, which still excludes tests, so this file's types
    // are checked only as a side effect of ESLint's project service resolving
    // `tsconfig.test.json` here. A type error in it fails `lint`, not `typecheck`.
    files: ['src/publicAssets.test.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
)
