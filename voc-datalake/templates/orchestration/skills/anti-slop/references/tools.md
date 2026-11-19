# Anti-Slop Tool Reference

The commands are shown as a developer types them. On the platform, a fixer or builder runs each as one `run` argv
(no shell: no `command -v`, `&&` or redirections; the result says when a tool is missing), with the repository's
installed binaries (`node_modules/.bin/knip` rather than `npx knip`) on its changed files. A reviewer runs none.
Installing a tool is a dependency change, decided before the first command.

## Tool Detection Commands

```bash
# Python tools
command -v ruff && ruff check --select F,C901,B,SIM,ARG,PERF,C4,UP,S --output-format json $TARGET 2>/dev/null
command -v vulture && vulture $TARGET --min-confidence 80 2>/dev/null
command -v radon && radon cc $TARGET -n C -s 2>/dev/null
command -v bandit && bandit -r $TARGET -ll -q 2>/dev/null

# TypeScript/JS tools
command -v npx && npx biome lint --reporter json $TARGET 2>/dev/null
[ -f node_modules/.bin/eslint ] && npx eslint --format json $TARGET 2>/dev/null
command -v npx && npx knip --no-exit-code 2>/dev/null
```

## Tool Config Audit

Verify configs are anti-slop optimized:
- **ruff**: `C901, B, SIM, ARG, PERF, C4, UP` in `select`
- **eslint**: `eslint-plugin-sonarjs` for cognitive complexity
- **semgrep**: custom rules for AI slop patterns (alternative to sloppylint)
- **biome**: complexity rules enabled in `biome.json`

## Verification Commands (post-fix)

```bash
# Python
ruff check --select F,C901,B,SIM,ARG,PERF,C4,UP,S .
semgrep scan --config auto --quiet .
vulture . --min-confidence 80
radon cc . -n C -s

# TypeScript
npx eslint --rule '{"sonarjs/cognitive-complexity": ["error", 15]}' .
npx knip --no-exit-code
npx biome lint .
```

## Install Reference

| Tool | Language | Install | Key Rules |
|---|---|---|---|
| ruff | Python | `uv add --dev ruff` | C901 complexity, B bugbear, SIM simplify, ARG unused, PERF |
| vulture | Python | `uv add --dev vulture` | Dead code (unused functions, imports, variables) |
| radon | Python | `uv add --dev radon` | Cyclomatic complexity, maintainability index |
| pylint | Python | `uv add --dev pylint` | R0801 duplicate-code |
| bandit | Python | `uv add --dev bandit` | Security anti-patterns |
| semgrep | Both | `uv add --dev semgrep` | Custom rules for any pattern |
| eslint-plugin-sonarjs | TS/JS | `npm i -D eslint-plugin-sonarjs` | cognitive-complexity, no-duplicate-string |
| knip | TS/JS | `npm i -D knip` | Unused exports, dependencies, files |
| biome | TS/JS | `npm i -D @biomejs/biome` | Complexity, style, performance |
| jscpd | Both | `npm i -g jscpd` | Cross-language copy-paste detection |
