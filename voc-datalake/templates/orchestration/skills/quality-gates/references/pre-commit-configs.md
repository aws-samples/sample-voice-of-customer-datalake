# Pre-Commit Configurations

## Python Project (.pre-commit-config.yaml)
```yaml
repos:
  # Formatting + security linting (fast, runs first)
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.17.3
    hooks:
      - id: ruff-format
      - id: ruff
        args: [--fix, --select, "F,C901,B,SIM,ARG,PERF,C4,UP,I,S"]

  # Basic file hygiene
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v6.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-json
      - id: check-merge-conflict
      - id: check-added-large-files
        args: ['--maxkb=500']
      - id: detect-private-key

  # Type checking (pyright, as the repository configures it; add stubs to additional_dependencies)
  - repo: https://github.com/RobertCraigie/pyright-python
    rev: v1.1.414
    hooks:
      - id: pyright
        additional_dependencies: [types-requests]
        stages: [pre-push]

  # Security: bandit (Python-specific, use pyproject.toml config if present)
  - repo: https://github.com/PyCQA/bandit
    rev: "1.9.4"
    hooks:
      - id: bandit
        args: [-q, -l]  # -l = LOW+ severity (not -ll which hides MEDIUM findings)
        exclude: tests/

  # Security: semgrep (SAST across Python + JS/TS). Org renamed from returntocorp to semgrep.
  - repo: https://github.com/semgrep/semgrep
    rev: v1.182.0
    hooks:
      - id: semgrep
        args: [--config, "p/python", --config, "p/owasp-top-ten", --error, --quiet]
        types_or: [python, javascript, typescript, jsx, tsx]
        exclude: tests/

  # Secrets detection
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.30.1
    hooks:
      - id: gitleaks
```

## TypeScript Project (.pre-commit-config.yaml)
```yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v6.0.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-json
      - id: check-merge-conflict
      - id: check-added-large-files
      - id: detect-private-key

  - repo: local
    hooks:
      - id: biome
        name: Biome lint and format
        entry: npx @biomejs/biome check --write
        language: system
        types_or: [javascript, jsx, ts, tsx, json]

      - id: tsc
        name: TypeScript type check
        entry: npx tsc --noEmit
        language: system
        types: [ts, tsx]
        pass_filenames: false
        stages: [pre-push]

      - id: knip
        name: Dead code detection
        entry: npx knip --no-exit-code
        language: system
        pass_filenames: false
        stages: [pre-push]
```

## Polyglot Project (Python + TypeScript)
Combine both configurations above.

## Tool Configuration

### Python (pyproject.toml)
```toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["F", "C901", "B", "SIM", "ARG", "PERF", "C4", "UP", "I", "S"]

[tool.ruff.lint.mccabe]
max-complexity = 10
```

### TypeScript (biome.json, Biome 2.x schema)
```json
{
  "$schema": "https://biomejs.dev/schemas/2.6.3/schema.json",
  "linter": {
    "enabled": true,
    "rules": { "preset": "recommended" }
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "assist": {
    "enabled": true,
    "actions": { "source": { "organizeImports": "on" } }
  }
}
```
Run the installed `node_modules/.bin/biome init` to regenerate against the installed version; the `$schema` URL
must match the installed `@biomejs/biome` version or the editor integration mismatches.

## CI Integration

Running the same hooks in CI (the `pre-commit/action` GitHub Action) is a CI definition: an agent never adds or
edits one. When the repository's CI does not run the hooks you added, say so in your finish, for a person to wire.

