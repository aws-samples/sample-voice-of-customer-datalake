# Tenets — check every change against TENETS.md

`TENETS.md` (repository root) holds the ranked product tenets (1–7) and the data lake tenets (D1–D7). Read it before
designing a change, and check the change against it before you hand it over. A change may not move the platform
further from a tenet. When two tenets conflict, the higher one wins, and the PR says so.

Stop and raise it with the user, instead of building it, when a change would:

- add a fixed monthly cost that is on by default: a WAF, SnapStart, provisioned concurrency, NAT, DAX, an always-on
  database, cache or container (tenet 7). A performance feature is opt-in behind its own `-c` flag, also turned on by
  `-c performanceTier=true` (`lib/utils/performance-tier.ts`), and listed in `OPT_IN_FIXED_COSTS` in
  `voc-datalake/lib/test-support/fixed-cost-rules.ts` (checked by `lib/fixed-cost-guard.test.ts`). Prefer making the Lambda faster over paying to hide a slow one;
- delete or overwrite customer data outside lawful erasure through `voc-retention` (D1, D5);
- enforce a rule, permission or AI mode only in the SPA, and not in the API / MCP (tenets 3 and 4);
- let an AI write bypass the server-side way-of-working check in `shared/ai_writing.py` (tenet 3);
- let a methodology step be skipped silently, or produce an artifact without its evidence (tenet 2).

Gaps the platform already has are listed in TENETS.md → "Where the platform stands today"; they are not a reason to
widen them.

Every pull request description carries a `## Tenets` section with ONE line `Tenets touched: <ids> | none`
(`scripts/pr-checks/tenets.mjs`; the ids are pinned against TENETS.md by `tenets.test.mjs`). A new tenet added to
TENETS.md must be added to `TENET_IDS` in the same change; that pull request names only the ids `main` already
knows, because the PR check runs `main`'s copy of the script.
