# Sources

Non-obvious claims and pinned versions in this skill, with the source checked and the date.

| Claim | Source | Checked |
|---|---|---|
| `ruff-pre-commit` current tag `v0.17.3` | `https://api.github.com/repos/astral-sh/ruff-pre-commit/tags` | 2026-10-28 |
| `bandit` current release `1.9.4`; `-l`/`-ll`/`-lll` map to LOW/MEDIUM/HIGH severity floor | `bandit --help` (local install), `https://pypi.org/pypi/bandit/json` | 2026-10-28 |
| Semgrep GitHub org renamed `returntocorp` -> `semgrep`; current tag `v1.182.0` | `https://github.com/returntocorp/semgrep` (301 redirect), `https://api.github.com/repos/semgrep/semgrep/tags` | 2026-10-28 |
| `gitleaks` current tag `v8.30.1` | `https://api.github.com/repos/gitleaks/gitleaks/tags` | 2026-10-28 |
| `pyright-python` tag `v1.1.414` is current | `https://api.github.com/repos/RobertCraigie/pyright-python/tags` | 2026-10-28 |
| `pre-commit/pre-commit-hooks` current tag `v6.0.0` | `https://api.github.com/repos/pre-commit/pre-commit-hooks/tags` | 2026-10-28 |
| `gitlint` tag `v0.19.1` is current; `contrib-title-conventional-commits` rule name is correct | `https://api.github.com/repos/jorisroovers/gitlint/tags`, `gitlint` package source | 2026-10-28 |
| Biome 2.x `biome.json` schema uses `"rules": {"preset": "recommended"}` and a top-level `assist` block, not the flat `complexity`/`style`/`suspicious`/`performance` groups from Biome 1.x | `https://biomejs.dev/guides/getting-started/` | 2026-10-28 |
| `actions/checkout` and `actions/setup-python` current major is `v7` | `https://api.github.com/repos/actions/checkout/tags`, `https://api.github.com/repos/actions/setup-python/tags` | 2026-10-28 |

Re-check pins periodically; `pre-commit autoupdate` is the authoritative source at the time you
run it. These pins are a reasonable starting point, not a permanent contract.
