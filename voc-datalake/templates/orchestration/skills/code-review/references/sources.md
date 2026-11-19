# Sources

Non-obvious claims verified for this skill, with the source checked and the date. Items not
listed below (ruff/bandit/gitleaks flags) were re-verified during this pass and found correct;
see the sources references of the `anti-slop` and `quality-gates` skills for the shared tool evidence.

| Claim | Source | Checked |
|---|---|---|
| `ruff check --output-format concise` is a valid, current flag value | `ruff check --help` (local install) | 2026-10-28 |
| `gitleaks dir <paths>` is current CLI syntax (`detect --source` is the older form) | `gitleaks detect --help` (local install, gitleaks 8.30.1) | 2026-10-28 |
| `bandit -l` (LOW+) vs default (MEDIUM+) severity floor | `bandit --help` (local install, bandit 1.9.4) | 2026-10-28 |
| `urllib.request.urlopen()` dynamic-URL risk is bandit rule `B310` | `PyCQA/bandit` source, `bandit/blacklists/calls.py` | 2026-10-28 |
| `defusedcsv` exists on PyPI as the standard CSV-formula-injection mitigation | `https://pypi.org/pypi/defusedcsv/json` | 2026-10-28 |
| `pylint` is GPL-2.0 licensed (reason for dev-only use); `jscpd` is MIT | `https://api.github.com/repos/pylint-dev/pylint`, npm registry for `jscpd` | 2026-10-28 |
