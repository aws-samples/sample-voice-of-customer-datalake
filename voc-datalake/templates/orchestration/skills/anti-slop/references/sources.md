# Sources

Non-obvious claims in this skill, with the source checked and the date.

| Claim | Source | Checked |
|---|---|---|
| The SonarSource ESLint cognitive-complexity plugin ships under the unscoped npm name `eslint-plugin-sonarjs` (not `@sonarsource/eslint-plugin-sonarjs`, which does not exist on npm); current version `4.2.2` | `https://registry.npmjs.org/eslint-plugin-sonarjs` | 2026-10-28 |
| `knip --no-exit-code` is a current, documented flag | `npx knip --help` (local run against knip 6.43.0) | 2026-10-28 |
| `defusedcsv` exists on PyPI (current `3.0.0`) and is the standard mitigation for CSV formula injection | `https://pypi.org/pypi/defusedcsv/json` | 2026-10-28 |
| `bandit -l` / `-ll` / `-lll` map to severity floor LOW / MEDIUM / HIGH | `bandit --help` (local install, bandit 1.9.4) | 2026-10-28 |
| `asyncio.get_event_loop()` deprecated behavior, `datetime.utcnow()` deprecated in 3.12 | Python 3.12 changelog / stdlib deprecation warnings | 2026-10-28 |

Python tool install commands use `uv add --dev <tool>` per this repo's own standard
(`skills/python-engineer/SKILL.md`), not `pip install`.
