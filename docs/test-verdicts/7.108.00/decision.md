---
item: 7.108.00
change: kind feature -> fix
proposed_by: voc-lead-3h/bf-window
reviewer: eval-bf/1
sha: 899574bd6bd1ace0edae933407f5e6fe23835cbd
tree: fb8272c026b880087f985a91a86166216cb118a4
---

## Reasons

A fix of existing behaviour, no new feature: a workspace manual import now takes the deployment retention window for its source, as every other ingestion path already does (cached_source_profile_strict), so a PII-allowed windowed source keeps a raw copy per item instead of one whole file; the CHANGELOG section has only Fixed, Upgrade notes and a tenet check.
