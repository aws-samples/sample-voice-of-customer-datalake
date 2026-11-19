# Sources

Non-obvious claims in this skill, verified against primary sources. Checked 2026-10-28.

| Claim | Source | Checked |
|---|---|---|
| Mermaid's current published version is 12.2.0 (the cookbook previously said "v11.x") | https://registry.npmjs.org/mermaid/latest | 2026-10-28 |
| The C4 diagram type (`C4Context`/`C4Container`/`C4Component`/`C4Deployment`) is still documented as experimental in current Mermaid docs | https://mermaid.js.org/syntax/c4.html | 2026-10-28 |

Mermaid ships frequent minor/major releases. Re-check `npm view mermaid version` and
https://mermaid.js.org/syntax/c4.html before asserting a version number or experimental
status as current.
