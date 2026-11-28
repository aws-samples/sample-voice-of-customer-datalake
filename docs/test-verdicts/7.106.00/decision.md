---
item: 7.106.00
change: kind feature -> plumbing
proposed_by: voc-lead-3h/s3b
reviewer: eval-s3b/1
sha: b311b18116206eb88fc34197a9cbc8a96ea78ad0
tree: 26f051bba50d83b594ef6874d173fded5d21bd40
---

## Reasons

The release's first paragraph says no production behaviour change: the projects seam's RESOLVE flag is off in every deployment until the flip (3h-S12), so no person or API caller can reach a workspace's product routes, and with no workspace every route, key and counter is exactly 7.105.00's (pinned by test_with_the_seam_off_a_header_changes_nothing). The user-visible feature comes with the flip, which carries the e2e layer.
