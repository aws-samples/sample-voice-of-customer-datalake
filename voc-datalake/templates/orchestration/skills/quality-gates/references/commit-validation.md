# Commit Message Validation

## Python Project: gitlint
Add to `.pre-commit-config.yaml`:
```yaml
  - repo: https://github.com/jorisroovers/gitlint
    rev: v0.19.1
    hooks:
      - id: gitlint
```

Add `.gitlint`:
```ini
[general]
contrib=contrib-title-conventional-commits

[title-max-length]
line-length=72

[title-must-not-contain-word]
words=wip,fixup,squash

[contrib-title-conventional-commits]
types=feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert
```

## TypeScript Project: commitlint
```bash
npm i -D @commitlint/cli @commitlint/config-conventional
```

Add `commitlint.config.js`:
```js
export default { extends: ['@commitlint/config-conventional'] };
```

Add to `.pre-commit-config.yaml`:
```yaml
  - repo: local
    hooks:
      - id: commitlint
        name: Commit message lint
        entry: npx commitlint --edit
        language: system
        stages: [commit-msg]
```

## Tool Choice
Choose ONE tool for your entire project: gitlint (Python-first) or commitlint (JS-first). Both enforce conventional commits; consistency matters more than which tool.

## Commit Message Anti-Slop Rules
These rules apply regardless of tool choice:
- **Subject line**: imperative mood, <72 chars, no period at end
- **Type prefix**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- **No vague subjects**: reject "update files", "fix bug", "refactor code", "misc changes"
- **No narrator voice**: reject "This commit...", "This PR...", "I have..."
- **No combining unrelated changes**: one logical change per commit
- **Body (optional)**: explain WHY, not WHAT. The diff shows what changed
