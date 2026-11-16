# Agent brief: set up and keep quality gates for dead code, duplication and "slop"

> **Proven on 2026-09-25** in a throwaway repo (Python 3.12 + TypeScript, macOS, Node 24) built only from this file: the pinned installs of Phase 1, every config and script copied as written, `scripts/validate.sh` green on clean code, all 20 planted violations of Phase 4 failing their gate, and both mutation paths reporting survivors (mutmut with `--patch`: 5 on a weakly tested function; Stryker with a `file:5-9` range: 3 of 4 mutants, all on those lines). The three gaps that run found are fixed below: a stale `noqa`, pyright unseen by knip, and the import roots of a source layout.

You are setting up a repository's quality gates from nothing, then fixing the code until every gate passes. After that, the gates keep the code in that shape. This file is self-contained: every config, script and helper you need is in it. Copy the blocks as written, change only the placeholders marked `<LIKE_THIS>`, and follow the phases in order.

**What "slop" means here**, and the gate that catches each kind:

| Slop | Caught by |
| --- | --- |
| A function, file, export, parameter or dependency nothing uses | vulture (Python), knip + `noUnused*` (TypeScript), ruff `ARG`/`F401` |
| Copy-pasted code, including a test that re-implements the code it tests | jscpd over code **and** tests in one run |
| An import that does not import (unused, or a re-export barrel) | ruff `F401`, tsc `noUnusedLocals`, knip, `no-re-exports` |
| Logic that says more than it does: a guard that can never fire, a cast to the type it already has, `if x: return True else: return False`, a loop that appends where a comprehension says it | ruff `SIM`/`RET`/`PIE`/`C4`/`PERF`/`FURB`, pyright `reportUnnecessary*`, typescript-eslint `no-unnecessary-*` |
| A type that lies (index reads assumed present, a parameter typed `str` whose body checks `isinstance(x, str)`) | `noUncheckedIndexedAccess`, `no-unnecessary-condition`, `reportUnnecessaryIsInstance` |
| A promise nobody awaits | `no-floating-promises`, `no-misused-promises` |
| A test that does not test: asserts nothing, is skipped or focused, or passes whatever the code does | vitest rules, `check_tests_assert.py`, mutation testing on the changed lines |
| A suppression that hides any of the above | `eslint-comments/no-use`, `RUF100`, `reportUnnecessaryTypeIgnoreComment` |

---

## Ground rules (read twice)

1. **Zero is the gate.** A gate passes only when it has zero findings. Do not write per-area "debt ceiling" scripts. If a tree cannot reach zero in this change, use the tool's own baseline (jscpd `--baseline` + `--fail-on-new-clones`, or one `# noqa: C901` on the def line of a function over the complexity limit) and never raise it.
2. **Never suppress.** No `// eslint-disable`, `@ts-ignore`, `@ts-expect-error`, blanket `# noqa`, `# type: ignore` or `# pyright: ignore`. No non-null assertion `!`, and no `as T` just to drop `undefined`. Fix the code, or make the type tell the truth. The config bans the suppressions, so don't try to get around the ban.
3. **Measure before you enable.** Run each new rule once as a warning, count its findings, and record the count. Turn it into an error in the same change that fixes them.
4. **Prove every gate looked.** A gate that scanned nothing also passes. For every gate, plant one violation, see the gate fail with the expected message, and revert it (Phase 4). Report the proof.
5. **Do not change behaviour.** This work changes structure, types and tests, not what the program does. If a fix would change behaviour, stop and report it instead. Do not delete a test to make a gate pass; fix the test.
6. **One phase per commit, with conventional messages** (`chore:`, `test:`, `docs:`). Commit only if the person who asked you allows it. Stage files by name, never `git add .`.
7. **Keep what the repo already enforces.** If a stricter existing rule conflicts with this brief, keep the stricter one. If the repo uses a different tool for the same job (flake8, black, pylint), ruff replaces flake8/isort/pylint-lite. Keep black (or `ruff format`) for formatting only.
8. **Say what you could not verify.** A green command is not proof unless you also proved it scanned something (rule 4).

---

## Phase 0: detect (read-only)

Run these commands and fill in the table below before you install anything.

```bash
git ls-files | sed -n 's/.*\.\([A-Za-z0-9]*\)$/\1/p' | sort | uniq -c | sort -rn | head -20    # languages
ls package.json package-lock.json pnpm-lock.yaml yarn.lock bun.lockb pyproject.toml setup.cfg requirements*.txt poetry.lock uv.lock Pipfile 2>/dev/null
git ls-files | grep -E '(^|/)package\.json$'          # one entry per JS/TS package (monorepo?)
git ls-files | grep -E '(^|/)tsconfig[^/]*\.json$'    # every TS program: each needs its own tsc step
git ls-files | grep -E '(^|/)(test_[^/]*|[^/]*_test)\.py$|(^|/)conftest\.py$' | head    # pytest layout
git ls-files | grep -E '\.(spec|test)\.[jt]sx?$' | head                                  # JS test layout
git ls-files | grep -E '(^|/)(\.eslintrc[^/]*|eslint\.config\.[cm]?js|\.flake8|setup\.cfg|tox\.ini|\.pylintrc|ruff\.toml|knip\.jsonc?|\.jscpd\.json|pyrightconfig\.json|mypy\.ini|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|stryker\.config\.[cm]?js)$'
ls .github/workflows 2>/dev/null; python3 --version; node --version
```

| Question | Your answer | Consequence |
| --- | --- | --- |
| Python source dirs (`<PY_DIRS>`, e.g. `src scripts`) | | Sections marked **[py]** apply |
| Python test layout: tests beside code, or in `tests/` | | `<PY_TEST_DIRS>`; the mutation report's test lookup |
| TS/JS packages (each dir with its own package.json) | | Each gets its own knip run, tsc run(s), vitest run |
| TS source dirs (`<TS_SRC>`, e.g. `src`) and entry files (`<TS_ENTRIES>`, e.g. `src/main.tsx`, `index.html`) | | knip `entry`/`project` |
| Test runner: vitest or jest | | jest: use `eslint-plugin-jest` with the same rule names (`jest/…`) |
| React? | | add `eslint-plugin-react-hooks` `recommended` (not required here) |
| Existing linters/configs to merge | | rule 7 |
| CI system | | CI calls `scripts/validate.sh`, nothing else |

Pick the Python version from the runtime the code ships to (`requires-python`, a Dockerfile, a Lambda runtime), not from your shell.

---

## Phase 1: install (pinned, dev-only)

These are the versions this setup was proven with. Use exact pins (`--save-exact`, `==`). If the repo is on an older major (for example eslint 8), upgrade it or stop and report.

**[ts]** In every JS/TS package that has TypeScript code:

```bash
npm i -D --save-exact typescript@5.9.3 eslint@9.39.5 typescript-eslint@8.67.0 \
  eslint-plugin-sonarjs@3.0.7 eslint-plugin-unicorn@62.0.0 \
  @eslint-community/eslint-plugin-eslint-comments@4.7.2 \
  knip@6.37.0 jscpd@5.2.1
# vitest users:
npm i -D --save-exact vitest@4.1.10 @vitest/eslint-plugin@1.6.27 @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0
```

(pnpm/yarn: the same packages and versions with `add -D --save-exact` / `add -D --exact`.) jscpd and pyright are Node tools; a Python-only repo still needs a `package.json` for them:

**[py]**

```bash
npm i -D --save-exact jscpd@5.2.1 pyright@1.1.408      # Python-only repos: `npm init -y` first
```

**[py]** Add to the dev requirements file (`requirements-dev.txt`, or `[project.optional-dependencies].dev` / `[dependency-groups].dev`):

```text
ruff==0.15.11
vulture==2.16
pytest==8.4.2
# mutmut 2.x on purpose: it mutates the named file in place and runs the tests you give it.
mutmut==2.5.1
# mutmut's `patch` extra, exactly: `scripts/mutate-python.sh --patch` reads the diff with it.
whatthepatch==0.0.6
```

Install them into the repo's virtualenv (`python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt`). Make sure `.venv/`, `node_modules/`, `.mutmut-cache`, `.stryker-tmp/`, `reports/` and `coverage/` are in `.gitignore`.

---

## Phase 2: configuration

### 2.1 [py] `pyproject.toml`

Merge these tables into the existing file; keep its other tables. Replace `<PY_DIRS>` and `<PY_VERSION>` (for example `py312`).

```toml
[tool.ruff]
target-version = "<PY_VERSION>"
line-length = 120
extend-exclude = [".venv", "node_modules", "dist", "build"]

[tool.ruff.lint]
select = [
    "F", "E", "W", "I", "B", "UP", "SIM", "RUF",   # correctness, imports (F401), modernisation, simplification
    "ARG",                                           # unused arguments (dead parameters)
    "RET", "PIE", "C4", "PERF", "PLW0108",           # returns, placeholders, comprehensions, loops, lambda wrappers
    "PLR1714", "PLR5501", "PLR1730",                 # `x == a or x == b`, `else: if`, hand-written min/max
    "FURB110", "FURB171", "FURB188",                 # `a if a else b`, `x in (y,)`, slice instead of removeprefix
    "ERA001",                                        # commented-out code
    "C901", "PLR0911", "PLR0912", "PLR0915",         # complexity, returns, branches, statements per function
    "S", "BLE001", "TRY002", "TRY300", "TRY301", "TRY400", "T20", "PT",
]
ignore = ["E501", "SIM108"]
# Framework callbacks that must accept an argument and usually ignore it go here, by name, and nowhere else.
dummy-variable-rgx = "^(_+|(_+[a-zA-Z0-9_]*[a-zA-Z0-9]+?)|context)$"

[tool.ruff.lint.mccabe]
max-complexity = 12

[tool.ruff.lint.pylint]
max-branches = 15
max-statements = 60
max-returns = 8

[tool.ruff.lint.per-file-ignores]
# Tests assert (S101) and hold fake secrets (S105/S106). Nothing else is exempt: an unused argument in a test is dead too.
"**/test_*.py" = ["S101", "S105", "S106"]
"**/conftest.py" = ["S101", "S105"]
"scripts/**" = ["T201"]     # scripts talk to a terminal

[tool.vulture]
paths = [<PY_DIRS as quoted, comma-separated strings>]
# vulture scores every unused function, class, attribute and variable at exactly 60 %; a higher floor cannot report a dead function.
min_confidence = 60
sort_by_size = true
# Only real entry points and named seams that production defines and only tests call, each with a comment.
ignore_names = []
# Do NOT list your own route/handler decorators here: they would hide every dead handler.
ignore_decorators = ["@pytest.fixture"]

[tool.pytest.ini_options]
testpaths = [<PY_TEST_DIRS as quoted strings>]
# A source layout that is not an installed package (tests do `from pricing import …`): name its dirs here.
pythonpath = [<PY_IMPORT_ROOTS as quoted strings, or delete this line>]
```

Do not put `exclude` in `[tool.vulture]`: vulture's CLI flags replace the pyproject values, and the script passes the excludes.

### 2.2 [py] `pyrightconfig.json`

```json
{
  "include": [<PY_DIRS as quoted strings>],
  "exclude": ["**/node_modules", "**/__pycache__", ".venv", "dist", "build"],
  "pythonVersion": "<3.12>",
  "extraPaths": [<PY_IMPORT_ROOTS as quoted strings, or delete this line>],
  "typeCheckingMode": "standard",
  "reportUnnecessaryIsInstance": "error",
  "reportUnnecessaryComparison": "error",
  "reportUnnecessaryContains": "error",
  "reportUnnecessaryCast": "error",
  "reportUnnecessaryTypeIgnoreComment": "error"
}
```

`standard`, not `strict`: `strict` floods a codebase that was never typed with thousands of findings. Zero findings in `standard` plus the five `reportUnnecessary*` checks is the target.

### 2.3 [ts] every `tsconfig*.json`

Add these to `compilerOptions` of **every** TypeScript program: the app, the config-files program, and any package with its own tsconfig.

```json
"strict": true,
"noUncheckedIndexedAccess": true,
"noUnusedLocals": true,
"noUnusedParameters": true,
"noImplicitReturns": true
```

Config files (`vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`) need a program that includes them, for example `tsconfig.node.json` with `"include": ["*.config.ts"]`. Otherwise nothing type-checks them.

### 2.4 [ts] `eslint.config.mjs` (one config at the repo root)

Replace `<TS_GLOBS>` (for example `'src/**/*.{ts,tsx}'`) and drop the vitest block if you have no vitest. For jest, swap `@vitest/eslint-plugin` for `eslint-plugin-jest` and `vitest/` for `jest/`.

```js
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import vitest from '@vitest/eslint-plugin';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import noReExports from './eslint-rules/no-re-exports.mjs';

const SPECS = ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/node_modules/**', '**/.stryker-tmp/**', '**/reports/**', '**/*.d.ts', '*.config.*', 'eslint-rules/**'] },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  eslintComments.recommended,
  {
    // No suppression comments at all: fix the finding.
    rules: { '@eslint-community/eslint-comments/no-use': ['error', { allow: [] }] },
  },
  {
    files: [<TS_GLOBS>],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: {
      unicorn,
      custom: { rules: { 'no-re-exports': noReExports } },
    },
    rules: {
      // size and shape
      complexity: ['error', 12],
      'max-depth': ['error', 3],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'prefer-const': 'error',
      'no-var': 'error',
      // no escape hatches
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }],
      // imports that do not import
      'custom/no-re-exports': 'error',
      // logic that says more than it does
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      'no-else-return': 'error',
      'no-lonely-if': 'error',
      'no-useless-return': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/no-useless-fallback-in-spread': 'error',
      // promises: awaited, returned, caught, or explicitly `void`ed
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
    },
  },
  {
    files: SPECS,
    plugins: { vitest },
    rules: {
      'max-lines': ['error', { max: 730, skipBlankLines: true, skipComments: true }],
      // a test that asserts nothing passes whatever the code does
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*'] }],
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'vitest/no-standalone-expect': 'error',
      'vitest/max-expects': ['error', { max: 4 }],
      'vitest/no-conditional-in-test': 'error',
      'vitest/no-conditional-expect': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-commented-out-tests': 'error',
      'vitest/prefer-strict-equal': 'error',
      'vitest/prefer-called-with': 'error',
      'vitest/require-to-throw-message': 'error',
    },
  },
);
```

`checksVoidReturn: { attributes: false }` allows an async function as a JSX event handler, because React discards its return value either way. Every other promise slot is checked.

### 2.5 [ts] `eslint-rules/no-re-exports.mjs`

This rule makes a module export only what it declares: no barrels, no `export … from`, no re-exporting an imported name. A barrel hides which file a name lives in, and keeps a file nobody else imports out of knip's unused-files report.

```js
function findVariable(scope, name) {
  const found = scope.set.get(name);
  if (found) return found;
  return scope.upper ? findVariable(scope.upper, name) : undefined;
}

function isImported(context, node, identifier) {
  if (identifier?.type !== 'Identifier') return false;
  const variable = findVariable(context.sourceCode.getScope(node), identifier.name);
  return Boolean(variable?.defs.some((definition) => definition.type === 'ImportBinding'));
}

export default {
  meta: {
    type: 'problem',
    docs: { description: "Disallow re-exporting another module's names; import from the defining module" },
    messages: {
      reExportFrom: "Re-export from '{{source}}': import from the defining module where the name is used, and delete this line.",
      reExportImport: "'{{name}}' is imported, not declared here: its importers should import it from the defining module.",
    },
    schema: [],
  },
  create(context) {
    const reportFrom = (node) => context.report({ node, messageId: 'reExportFrom', data: { source: node.source.value } });
    return {
      ExportAllDeclaration: reportFrom,
      ExportNamedDeclaration(node) {
        if (node.source) {
          reportFrom(node);
          return;
        }
        for (const specifier of node.specifiers) {
          if (isImported(context, node, specifier.local)) {
            context.report({ node: specifier, messageId: 'reExportImport', data: { name: specifier.local.name } });
          }
        }
      },
      ExportDefaultDeclaration(node) {
        if (isImported(context, node, node.declaration)) {
          context.report({ node, messageId: 'reExportImport', data: { name: node.declaration.name } });
        }
      },
    };
  },
};
```

A library's public entry file (the `main`/`exports` of a published package) is the one place a re-export can be legitimate. List that one file in an `ignores` of the rule's block, with a comment saying why.

### 2.6 [ts] `knip.jsonc` (one per JS/TS package, in the package directory)

The `!` suffix marks production files. `--production` analyses only those, so an export that only a spec imports is reported.

```jsonc
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  // The files the bundler/runtime starts from. index.html is read for its <script> tags.
  "entry": [<TS_ENTRIES with a trailing ! each, e.g. "src/main.tsx!">],
  "project": [
    "<TS_SRC>/**/*.{ts,tsx}!",
    "!<TS_SRC>/**/*.{spec,test}.{ts,tsx}!",
    "!<TS_SRC>/**/*-fixtures.{ts,tsx}!",
    "!<TS_SRC>/test/**!"
  ],
  // Off: an export only its own file uses is a finding (nothing imports it, not even a spec).
  // scripts/knip-production.mjs turns it back on for --production, where an export its own file uses
  // and a spec imports is a testing seam.
  "ignoreExportsUsedInFile": false
}
```

If knip reports a dependency that only non-JS config uses (for example `ts-node` named in a JSON file, a CLI called from a shell script), add it to `"ignoreDependencies"` with a comment. Never add a real source file to `ignore`.

### 2.7 [ts] `scripts/knip-production.mjs` (once, at the repo root)

```js
/**
 * knip's production run: the knip.jsonc of the directory knip runs from, with ignoreExportsUsedInFile
 * turned back on, so an export that its own file uses and a spec imports is a testing seam, not dead.
 * Usage (from the package directory): npx knip --config <path-to>/scripts/knip-production.mjs --production --strict
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

// The package's own typescript reads the JSONC (comments allowed).
const ts = createRequire(path.join(process.cwd(), 'package.json'))('typescript');
const file = path.join(process.cwd(), 'knip.jsonc');
const { config } = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));

export default { ...config, ignoreExportsUsedInFile: true };
```

For a Python-only repo, skip 2.6 and 2.7.

### 2.8 `.jscpd.json` (repo root, all languages, code and tests in one run)

```json
{
  "format": ["python", "typescript", "tsx", "javascript"],
  "mode": "weak",
  "crossFormats": ["typescript,tsx"],
  "minTokens": 40,
  "minLines": 5,
  "threshold": 0,
  "gitignore": true,
  "absolute": false,
  "reporters": ["console"],
  "path": [<every source and test dir, quoted>],
  "ignore": ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/__pycache__/**", "**/.venv/**", "**/*.d.ts"],
  "ignorePattern": [
    "import\\s+(?:type\\s+)?[\\w$]+(?:\\s*,\\s*\\{[^}]*\\})?\\s+from\\s+['\"][^'\"]+['\"];?",
    "import\\s+(?:type\\s+)?\\{[^}]*\\}\\s*from\\s+['\"][^'\"]+['\"];?",
    "import\\s+\\*\\s+as\\s+[\\w$]+\\s+from\\s+['\"][^'\"]+['\"];?",
    "from\\s+[\\w.]+\\s+import\\s+\\([^)]*\\)",
    "from\\s+[\\w.]+\\s+import\\s+[^\\n]+",
    "(?m)^import\\s+[\\w.]+(?:\\s+as\\s+\\w+)?(?:\\s*,\\s*[\\w.]+)*$"
  ]
}
```

Keep only the formats the repo has.
- **Weak mode:** the default "mild" mode counts comments, so two copies with different comments are missed.
- **`crossFormats`:** compares `.ts` with `.tsx`.
- **`ignorePattern`:** skips import statements; a list of dependencies is not logic.
- **Tests and production code in one run:** otherwise a test that copies the logic it tests is never compared with that logic.
- **Accepted pairs:** the only exception is a pair kept on purpose (two bundles that cannot import each other, a literal that *is* the assertion). Mark it:

  ```
  // jscpd:ignore-start — <why this pair stays>
  ...
  // jscpd:ignore-end of the accepted pair
  ```

  Use `#` in Python. The end marker carries words so that ruff's `ERA001` does not read it as commented-out code.

### 2.9 [ts, vitest] `stryker.config.mjs` (per package that has vitest specs)

```js
export default {
  testRunner: 'vitest',
  mutate: ['<TS_SRC>/**/*.{ts,tsx}', '!<TS_SRC>/**/*.{spec,test}.{ts,tsx}', '!<TS_SRC>/**/*-fixtures.{ts,tsx}', '!<TS_SRC>/test/**', '!<TS_SRC>/**/*.d.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress'],
  clearTextReporter: { allowColor: false, reportTests: false },
  tempDirName: '.stryker-tmp',
  timeoutMS: 20000,
  timeoutFactor: 2,
  thresholds: { high: 100, low: 0, break: null },
};
```

`break: null` is deliberate: mutation is a report you act on, not a percentage gate.

### 2.10 [ts] `<TS_SRC>/test/definedValue.ts` (spec helper)

With `noUncheckedIndexedAccess`, `rows[0]` is `T | undefined`. Specs narrow with this helper instead of `!`, a cast, or a conditional in the test body:

```ts
/** A spec read a value its fixture promised and found nothing there: the fixture, not the code under test, is wrong. */
class FixtureValueMissingError extends Error {
  constructor(what: string) {
    super(`The fixture has no ${what}`);
    this.name = 'FixtureValueMissingError';
  }
}

/** `definedValue(rows[0], 'the first row')`: the value a spec indexes out of its own fixture, or a throw. */
export function definedValue<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new FixtureValueMissingError(what);
  }
  return value;
}
```

Keep the class unexported: knip fails an export that nothing imports.

---

## Phase 3: scripts

Create each file with `chmod +x`. They are bash, and they run on macOS's bash 3.2 as well as on Linux.

### 3.1 [py] `scripts/lint-python.sh`: vulture in two passes

```bash
#!/usr/bin/env bash
# Dead Python code, two passes, one gate.
#   --dead-code        production code with the tests left out: a function only a test calls is dead.
#   --dead-code-tests  the whole tree, printing only what the first pass did not: dead test helpers and fixtures.
# Paths, floor and allowlists live in pyproject.toml [tool.vulture]; vulture's CLI flags REPLACE pyproject
# values, so this script passes only the excludes, which are the one thing the passes differ in.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

EXCLUDE='*/.venv/*,*/node_modules/*,*/__pycache__/*,*/dist/*,*/build/*'
TEST_FILES='*/test_*.py,*_test.py,*/conftest.py'
FOUND_EXIT=3

case "${1:-}" in
  --dead-code)
    vulture --exclude "$EXCLUDE,$TEST_FILES"
    ;;
  --dead-code-tests)
    production="$(vulture --exclude "$EXCLUDE,$TEST_FILES" || true)"
    everything="$(vulture --exclude "$EXCLUDE" || true)"
    if [[ -z "$production" ]]; then
      tests_only="$everything"
    else
      tests_only="$(grep -vxF -f <(printf '%s\n' "$production") <<<"$everything" || true)"
    fi
    if [[ -n "$tests_only" ]]; then
      printf '%s\n' "$tests_only"
      exit "$FOUND_EXIT"
    fi
    ;;
  *)
    echo "usage: $0 --dead-code | --dead-code-tests" >&2
    exit 2
    ;;
esac
```

### 3.2 [py] `scripts/check_tests_assert.py`: every pytest test asserts

ruff has no "test without an assertion" rule, so this small script adds one.

```python
#!/usr/bin/env python3
"""Every pytest test asserts something: a bare ``assert``, ``pytest.raises``/``warns``/``fail``, a mock's
``assert_*`` method, or a local helper that does one of those (followed through the module's own functions).
A test that asserts nothing passes whatever the code does. Exit 1 listing each one."""
from __future__ import annotations

import ast
import subprocess
import sys

ASSERTING_CALLS = {'raises', 'warns', 'fail', 'deprecated_call'}
ASSERTING_PREFIXES = ('assert', 'expect')


def _call_name(call: ast.Call) -> str:
    func = call.func
    if isinstance(func, ast.Attribute):
        return func.attr
    return func.id if isinstance(func, ast.Name) else ''


def _asserts(node: ast.AST, helpers: dict[str, ast.AST], seen: set[str]) -> bool:
    for sub in ast.walk(node):
        if isinstance(sub, ast.Assert):
            return True
        if not isinstance(sub, ast.Call):
            continue
        name = _call_name(sub)
        if name in ASSERTING_CALLS or name.startswith(ASSERTING_PREFIXES):
            return True
        if name in helpers and name not in seen:
            seen.add(name)
            if _asserts(helpers[name], helpers, seen):
                return True
    return False


def _test_files() -> list[str]:
    listed = subprocess.run(['git', 'ls-files', '*.py'], capture_output=True, text=True, check=True).stdout.split()  # noqa: S607 — git from PATH
    return [f for f in listed if f.rsplit('/', 1)[-1].startswith('test_') or f.endswith('_test.py')]


def main() -> int:
    silent: list[str] = []
    for path in _test_files():
        with open(path, encoding='utf-8') as handle:
            tree = ast.parse(handle.read(), filename=path)
        functions = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]
        helpers = {f.name: f for f in functions if not f.name.startswith('test_')}
        silent.extend(
            f'{path}:{f.lineno} {f.name}' for f in functions if f.name.startswith('test_') and not _asserts(f, helpers, set())
        )
    for line in silent:
        print(f'test asserts nothing: {line}')
    return 1 if silent else 0


if __name__ == '__main__':
    sys.exit(main())
```

A "does not raise" test still needs an assertion on its result (`assert fn(x) is None`). If you want this script's own behaviour pinned, give it a test.

### 3.3 [py] `scripts/mutate-python.sh`: mutation testing, whole module or changed lines

```bash
#!/usr/bin/env bash
# Mutation testing for one Python module (mutmut 2.x). Not a gate: a per-module tool, run on what a change touches.
#
#   scripts/mutate-python.sh [--patch <git-range>] <module.py> <test file or dir> [more tests...]
#   scripts/mutate-python.sh --patch origin/main src/pricing.py tests/test_pricing.py
#
# --patch mutates only the lines the range added or changed in the module (`git diff <range>`; a single ref
# compares it with the working tree). A mutant the tests kill is behaviour they pin. A survivor is either a
# statement no test observes (strengthen the test) or a statement with no effect (delete it); an equivalent
# mutant is the one case to leave, marked `# pragma: no mutate` with the reason.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PATCH_RANGE=""
if [[ "${1:-}" == "--patch" ]]; then
  PATCH_RANGE="${2:-}"
  shift 2 || true
fi
if [[ $# -lt 2 || "$PATCH_RANGE" == -* ]]; then
  sed -n '4,5p' "$0" >&2
  exit 2
fi
MODULE="$1"; shift
TESTS=("$@")
PYTHON="${PYTHON_BIN:-python}"

rm -f .mutmut-cache   # a clean cache per run: another module's entries only confuse `mutmut results`

PATCH_ARGS=()
if [[ -n "$PATCH_RANGE" ]]; then
  PATCH_FILE="$(mktemp "${TMPDIR:-/tmp}/mutmut-patch.XXXXXX")"
  trap 'rm -f "$PATCH_FILE"' EXIT
  git diff --unified=0 --no-ext-diff "$PATCH_RANGE" -- "$MODULE" > "$PATCH_FILE"
  if [[ ! -s "$PATCH_FILE" ]]; then
    echo "No lines of $MODULE changed in $PATCH_RANGE: nothing to mutate (drop --patch for the whole module)" >&2
    exit 2
  fi
  PATCH_ARGS=(--use-patch-file "$PATCH_FILE")
fi

echo "==> Baseline: the tests must pass unmutated"
"$PYTHON" -m pytest -q -p no:cacheprovider "${TESTS[@]}"

echo "==> Mutating ${PATCH_RANGE:+the lines changed in $PATCH_RANGE of }$MODULE"
# mutmut 2 counts only exit 1 as "killed"; pytest exits 2 when a mutant breaks the import (a collection
# error), which would count as survived, hence `|| exit 1`. -x: one failing test is enough.
mutmut run \
  --paths-to-mutate "$MODULE" \
  --tests-dir "$(dirname "${TESTS[0]}")" \
  --runner "sh -c '$PYTHON -m pytest -x -q -p no:cacheprovider ${TESTS[*]} || exit 1'" \
  ${PATCH_ARGS[@]+"${PATCH_ARGS[@]}"} \
  --no-progress || true   # mutmut exits non-zero when mutants survive; the results below are the point

# An interrupted run can leave a mutant in the file; mutmut keeps the original in <module>.bak.
if [[ -f "$MODULE.bak" ]]; then mv -f "$MODULE.bak" "$MODULE"; fi

echo "==> Results (mutmut show <id> prints a survivor's diff)"
mutmut results || true
```

Do not run git commands that write to the tree (checkout, stash, commit) while a mutation run is going: mutmut rewrites the module in place.

### 3.4 `scripts/mutation-report.sh`: the release's changed lines, mutated against their tests

```bash
#!/usr/bin/env bash
# The mutation report of a change: every module it touched, mutated against its own tests, only the
# lines it added or changed (a module whose test alone changed is mutated whole: a test change is the
# moment to ask what else the tests miss). A report you act on before merging/releasing, not a gate.
#
#   scripts/mutation-report.sh <base-ref>            # e.g. origin/main, or the last release tag
#   scripts/mutation-report.sh <base-ref> --whole    # every changed module whole
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${1:?usage: $0 <base-ref> [--whole]}"
WHOLE="${2:-}"

own_lines_changed() { [[ "$WHOLE" != "--whole" ]] && ! git diff --quiet "$BASE" -- "$1"; }

# ---- Python: module -> its namesake test (test_<stem>.py anywhere in the repo) ----
py_changed() {
  git diff --name-only "$BASE" -- '*.py' | while IFS= read -r f; do
    base="$(basename "$f")"
    case "$base" in
      conftest.py|__init__.py) ;;
      test_*.py) stem="${base#test_}"; git ls-files "*/$stem" "$stem" | head -1 ;;
      *) [[ -f "$f" ]] && echo "$f" ;;
    esac
  done | sort -u
}
for module in $(py_changed); do
  stem="$(basename "$module" .py)"
  tests="$(git ls-files "*test_${stem//-/_}.py" | tr '\n' ' ')"
  if [[ -z "$tests" ]]; then echo "--- $module: NO TESTS (a finding)"; continue; fi
  scope=()
  own_lines_changed "$module" && scope=(--patch "$BASE")
  echo "--- $module (${scope[*]:-whole}) against: $tests"
  # shellcheck disable=SC2086
  bash scripts/mutate-python.sh ${scope[@]+"${scope[@]}"} "$module" $tests || echo "    (tests fail unmutated, or no changed lines)"
done

# ---- TypeScript: file -> its spec beside it; Stryker line ranges per changed hunk ----
# Set PKG to the package directory that holds stryker.config.mjs (e.g. "web"), or "." for the root.
PKG="${PKG:-.}"
ts_changed() {
  git diff --name-only "$BASE" -- "$PKG" | grep -E '\.tsx?$' | grep -vE '\.d\.ts$|-fixtures\.|/test/' | while IFS= read -r f; do
    case "$f" in
      *.spec.ts|*.spec.tsx|*.test.ts|*.test.tsx) m="$(sed -E 's/\.(spec|test)\.(tsx?)$/.\2/' <<<"$f")"; [[ -f "$m" ]] && echo "$m" ;;
      *) [[ -f "$f" ]] && echo "$f" ;;
    esac
  done | sort -u
}
for file in $(ts_changed); do
  ext="${file##*.}"; spec_a="${file%.*}.spec.$ext"; spec_b="${file%.*}.test.$ext"
  if [[ ! -f "$spec_a" && ! -f "$spec_b" ]]; then echo "--- $file: NO SPEC (a finding)"; continue; fi
  relative="${file#"$PKG"/}"
  target="$relative"
  if own_lines_changed "$file"; then
    target="$(git diff --unified=0 "$BASE" -- "$file" \
      | sed -nE 's/^@@ -[0-9,]+ \+([0-9]+)(,([0-9]+))? @@.*/\1 \3/p' \
      | awk -v f="$relative" '{ n = ($2 == "" ? 1 : $2); if (n > 0) printf "%s%s:%d-%d", (c++ ? "," : ""), f, $1, $1 + n - 1 }')"
  fi
  if [[ -z "$target" ]]; then echo "--- $file: only deletions"; continue; fi
  echo "--- $file ($target)"
  (cd "$PKG" && npx stryker run --mutate "$target") | grep -E '^\[Survived\]|^[-+] |^ *[A-Za-z].*\|' || true
done
```

Every survivor the report prints gets exactly one outcome before merge or release:
- a test that kills it;
- deleting the statement it proves has no effect;
- an equivalence marker with its reason (`# pragma: no mutate`, or `// Stryker disable next-line <mutator>: <reason>`).

### 3.5 `scripts/validate.sh`: every gate, in order, each a hard stop

Delete the steps for a language the repo does not have. Add one `tsc` step per TypeScript program and one knip/vitest pair per JS/TS package. CI runs this script and nothing else.

```bash
#!/usr/bin/env bash
# Every gate, cheapest first, tests last; a green run here is a green CI run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# One command per step: under `set -e` a failure on the left of `&&` does not stop the script.

if [[ -z "${PYTHON_BIN:-}" ]]; then
  if [[ -x .venv/bin/python ]]; then PYTHON_BIN="$PWD/.venv/bin/python"; else PYTHON_BIN="$(command -v python3)"; fi
fi
export PYTHON_BIN
PATH="$(dirname "$PYTHON_BIN"):$PATH"   # ruff, vulture, pytest from the same environment
export PATH
step() { printf '\n==> %s\n' "$1"; }

# ---- Python ----
step "ruff";                              ruff check <PY_DIRS>
step "vulture: production code";          bash scripts/lint-python.sh --dead-code
step "vulture: test-support code";        bash scripts/lint-python.sh --dead-code-tests
step "pyright";                           npx pyright --pythonpath "$PYTHON_BIN"
step "every test asserts";                "$PYTHON_BIN" scripts/check_tests_assert.py
step "pytest";                            "$PYTHON_BIN" -m pytest -q -p no:cacheprovider

# ---- TypeScript (repeat per program / package) ----
step "tsc: <program>";                    npx tsc -p <tsconfig.json> --noEmit
step "eslint";                            npx eslint .
step "knip: <pkg>";                       (cd <pkg> && npx knip)
step "knip --production: <pkg>";          (cd <pkg> && npx knip --config <rel-path-to>/scripts/knip-production.mjs --production --strict)
step "vitest: <pkg>";                     (cd <pkg> && npx vitest run)

# ---- Everything ----
step "jscpd: code and tests";             npx jscpd --fail-on-empty

printf '\nvalidate: every gate passed\n'
```

Add to the root `package.json`:

```json
"scripts": {
  "validate": "bash scripts/validate.sh",
  "duplication": "jscpd --fail-on-empty",
  "duplication:pairs": "jscpd --reporters consoleFull",
  "typecheck:python": "pyright",
  "dead-code": "knip",
  "dead-code:prod": "knip --config scripts/knip-production.mjs --production --strict",
  "mutation:report": "bash scripts/mutation-report.sh"
}
```

(Python-only repo: keep `validate`, `duplication`, `duplication:pairs`, `typecheck:python`, `mutation:report`.) knip reads `package.json` scripts, not shell scripts: a tool that only `validate.sh` calls is reported as an unused devDependency until a script names it, which is why `typecheck:python` is here. A stale `"main"` field (npm init writes `index.js`) is a knip configuration hint; delete it or point it at the real entry.

---

## Phase 4: prove every gate works (mandatory)

For each row: make the planted change in a scratch file (or a real file), run the gate, confirm it **fails with the message shown**, then revert with `git checkout -- <file>` or delete the scratch file. Put the table, with a ✔ per row, in your report. A row you cannot make fail means that gate is not wired: fix the wiring, not the row.

| Gate | Plant this | Must fail with |
| --- | --- | --- |
| ruff F401 | `import os` unused in a module | `F401` … `imported but unused` |
| ruff PERF401 | `out = []` / `for x in xs: out.append(x * 2)` | `PERF401` |
| ruff ARG | a function parameter nobody reads | `ARG001` |
| vulture (production) | a function that only a test calls | `unused function '<name>' (60% confidence)` from `--dead-code` |
| vulture (tests) | a helper in `conftest.py` nothing calls | the same message, from `--dead-code-tests` |
| pyright | `def f(x: str) -> str:` / `return x if isinstance(x, str) else ''` | `reportUnnecessaryIsInstance` |
| check_tests_assert | `def test_nothing(): compute(1)` | `test asserts nothing: …` |
| tsc noUncheckedIndexedAccess | `const xs = [1]; const n: number = xs[0];` | `TS2322 … 'number \| undefined'` |
| tsc noUnusedLocals | an unused `const` | `TS6133` |
| eslint no-unnecessary-condition | `const s: string = 'a'; const t = s ?? 'b';` | `@typescript-eslint/no-unnecessary-condition` |
| eslint no-floating-promises | a bare `fetchThing();` call returning a promise | `@typescript-eslint/no-floating-promises` |
| eslint no-re-exports | `export { a } from './a';` | `custom/no-re-exports` |
| eslint no-use (suppressions) | `// eslint-disable-next-line` above any line | `eslint-comments/no-use` |
| vitest expect-expect | `it('does something', () => { render(); });` | `vitest/expect-expect` |
| vitest no-focused-tests | `it.only(...)` | `vitest/no-focused-tests` |
| knip (default) | in a non-entry file, `export` a `const` that only that file uses (knip treats an entry file's exports as public) | `Unused exports (1)` |
| knip (production) | an exported function that only a spec imports | `Unused exports` in the `--production` run only |
| knip (files) | a new `.ts` file nothing imports | `Unused files (1)` |
| jscpd | copy a 10-line function into another file | `Found 1 clones` and exit 1 |
| jscpd empty scan | `npx jscpd --fail-on-empty <an empty dir>` | exit 1 |
| mutation (Python) | a function with a test that calls it but never checks the result | at least one `Survived` in `scripts/mutate-python.sh` |
| mutation (TS) | the same, with `npx stryker run --mutate "<file>:<a>-<b>"` | a `[Survived]` line, mutants only on lines a–b |

Also confirm that each gate **scanned what it should**. jscpd prints "Files analyzed" per format: compare it with `git ls-files | grep -cE '\.(py|ts|tsx)$'`. pyright prints the number of files it analysed. vitest and pytest print their test counts. Record the numbers.

---

## Phase 5: baseline, then fix, in this order

Run every new rule once as a warning, count the findings (commands below), and write the counts down. Then fix one group, turn it on as an error, run `scripts/validate.sh`, and commit. The order goes from the cheapest group to the most invasive.

```bash
# counts, before enabling (Python)
ruff check <PY_DIRS> --statistics --select PIE,C4,PERF,RET,PLW0108,PLR1714,PLR5501,PLR1730,FURB110,FURB171,FURB188,ARG
# counts, before enabling (TS): run eslint once with the new rules at "warn" and count per rule
npx eslint . -f json -o /tmp/eslint.json; node -e 'const r=require("/tmp/eslint.json");const c={};for(const f of r)for(const m of f.messages)c[m.ruleId]=(c[m.ruleId]||0)+1;console.log(c)'
# counts, noUncheckedIndexedAccess, per program
npx tsc -p <tsconfig.json> --noEmit --noUncheckedIndexedAccess 2>&1 | grep -c 'error TS'
```

1. **Dead code, imports and duplication**: vulture, knip, `F401`/`ARG`, `no-re-exports`, jscpd. Delete what is dead. Wire in what is really used but invisible to the tool (an entry point, a CLI named only in a config file), and add a comment saying why. Extract duplicates into a module with a specific name, never `utils`. Put shared spec data in `*-fixtures.ts` or `conftest.py`.
2. **Logic that says more than it does**: ruff `PIE C4 PERF RET PLW0108 PLR… FURB…`, pyright `reportUnnecessary*`, typescript-eslint `no-unnecessary-type-assertion`, `boolean-literal-compare`, `template-expression`, `redundant-type-constituents`, `no-else-return`, `no-lonely-if`, the unicorn rules. `ruff check --fix` and `eslint --fix` do most of it. Review every automatic change, especially `--unsafe-fixes`.
3. **Tests that test**: `vitest/*`, `check_tests_assert.py`. Rename assertion helpers to `expect…`. Fill in or delete empty tests; a test named "never raises" asserts on the result.
4. **Types that do not lie**: `noUncheckedIndexedAccess` in every tsconfig, then `no-unnecessary-condition`, `no-floating-promises`, `no-misused-promises`. This is the largest group. If it has more than about 150 findings, split the tree into folders that do not overlap and give each worker the "how to fix" rules below. Afterwards, re-run jscpd (new `definedValue(...)` lines can create clones) and knip (removing a `?? x.field` read can leave a type member unread).
5. **Mutation on the change**: run `scripts/mutation-report.sh <base>` on the branch. Kill, delete or mark every survivor.

### How to fix each kind (the rules that keep the fix from becoming new slop)

- **An index read in production code**: prefer a shape that is provably safe:
  - destructuring with a default (`const [first = fallback] = list`);
  - `.find(...)`, `for (const x of list)` or `Object.entries(...)`;
  - a `Map` instead of an object used as a map;
  - a non-empty tuple type (`readonly [T, ...T[]]`) for a list that is fixed by design.

  Use `?? fallback` only when the fallback is what the code *should* do. If absence is impossible and nothing sensible can replace it, throw a small named error class. Never use `!`, and never cast.
- **An index read in a spec**: `definedValue(rows[0], 'the first row')`, or assert the whole structure with `toStrictEqual([...])`.
- **A guard the types say can never fire** (`no-unnecessary-condition`, `reportUnnecessaryIsInstance`), first decide where the value comes from:
  - **It crosses a boundary** (HTTP body, `JSON.parse`, model output, `localStorage`, env var, DOM): keep the guard and make the type honest. Mark the field optional, type the parameter `object`/`unknown`/`list[Any]`, or read it through a local `Partial<…>`.
  - **It is internal and already has that type**: delete the guard.
  - **Check the producer (the backend, the parser) before deciding.** If a shared type lies about a response, fix the type at its source rather than per consumer, and list any you leave.
- **A floating promise**:
  - `await` it when order matters.
  - `void p` only when `p` already catches its own errors (check it).
  - Otherwise add a `.catch(...)` that does what the surrounding code does with errors.
  - In specs, `await` it.
- **A dead parameter** (`ARG`): remove it from the signature and every caller. If a framework requires it, name it `_name`, or add its name to `dummy-variable-rgx` once for the whole repo.
- **Complexity over 12**: extract a pure helper or a sibling component. Do not raise the limit.
- **A test the new rules flag**: fix the test's shape (split it at 4 `expect`s, move a conditional into a helper that throws). Never delete an assertion to pass `max-expects`: move it into its own test.

---

## Phase 6: keep it (every future change)

- Run `scripts/validate.sh` before calling any change done. Green means every gate, not "mostly".
- Before merging or releasing, run `scripts/mutation-report.sh <base-ref>` and resolve every survivor it names (kill, delete, or mark as equivalent with a reason). Write the survivor count and what you did about each into the PR or release notes.
- Adding code:
  - Export only what another module imports.
  - A function or export only a test uses is dead.
  - A new cross-language copy of a constant needs a test that reads both copies.
  - New spec helpers go in `*-fixtures.ts`, `src/test/` or `conftest.py`.
  - No new `jscpd:ignore` without its reason; no new entry in any allowlist without its comment.
- Never raise a limit (complexity 12, depth 3, 400 lines, 4 expects, 0 clones, 60 % vulture). If something cannot fit, split it.
- A finding that looks wrong is usually a type that lies, a missing entry point, or a real bug. Investigate it before adding an allowlist entry, and never add a suppression comment.

---

## Report (what you hand back)

1. The **Phase 0 table** as filled in.
2. **What you installed**, with versions, and which files you created or changed.
3. The **Phase 4 proof table**, with ✔ per row and the scan counts.
4. The **Phase 5 baseline counts** per rule, before and after (after must be 0), and which fixes were automatic and which were by hand.
5. **Every place you threw a named error instead of falling back**, and every shared type you found lying, marked fixed or left (file:line and why).
6. The **mutation report's survivors** and the outcome for each.
7. **What you could not verify**, stated plainly.
