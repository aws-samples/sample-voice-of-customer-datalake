---
item: 7.109.00
change: kind feature -> fix
proposed_by: voc-lead-3h/bf-whole
reviewer: eval-bf2/1
sha: 47b79594b4c422aec2d0cce775ae0e1f23d70eec
tree: 51d6a05e61a498eba9bb0426a78c47c32e71fd5b
---

## Reasons

A bug fix to the retention worker (shared/retention.py whole_upload_key and jobs/retention/copies.py _whole_upload): it lists for review the whole files an erased item came from in a workspace and every paste, which it missed. No new behaviour beyond the existing review list; CHANGELOG 7.109.00 files it under Fixed.
