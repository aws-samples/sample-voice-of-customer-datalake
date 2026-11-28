---
item: 7.107.00
change: exemption all no-behaviour 67e5a161e962
proposed_by: voc-lead-3h/m0
reviewer: eval-m0/1
sha: 5206884546132df2301d8e3a01f25df5e9b7ca03
tree: 18ea1333e39fb16b8673d6a422a115efa1d1bf27
---

## Reasons

I checked the staged change on HEAD 5206884546132df2301d8e3a01f25df5e9b7ca03 (`git diff --cached --stat`, and the
diff with docs and markdown excluded). 13 files changed. Outside docs and markdown, only these did: the `version` field
(7.106.0 to 7.107.0) of the three package.json files and their lock files' own version fields, three `templateSha256`
lines in voc-datalake/lib/test-support/baseline.json, and this item's registry entry. No file under
voc-datalake/lambda, voc-datalake/lambda/stream/src, voc-datalake/frontend/src or voc-datalake/lib changed except that
test-support baseline.

The hash lines move with the release number alone: `appVersion()` (lib/utils/connector-version.ts, from the root
package.json) is set as `APP_VERSION` in the Lambda environments of the API, processing and core stacks, which are
exactly the three stacks whose hashes changed. Every earlier release's commit touched baseline.json the same way. I did
not re-run the synth myself; the CDK suite's baseline test checks the hashes in the full gate.

The rest is docs: docs/multi-workspace.md (the 3h-M0 design of the migration into `default`, and 3h re-planned),
docs/deployment.md (one note), TENETS.md (a sentence each on tenet 6 and D8, and the gaps table) and CHANGELOG.md.
Nothing in the design is built, so no code path exists for a unit test to run, and no person or API caller sees a
difference, so there is no flow for an end-to-end test. An `all`-layer no-behaviour exemption is the right record for
this item. The slices that build the migration (M1 to M4) carry their own tests. The exemption's reason describes the
change accurately.
