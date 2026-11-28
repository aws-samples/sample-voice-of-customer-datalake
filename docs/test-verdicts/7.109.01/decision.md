---
item: 7.109.01
change: kind feature -> fix
proposed_by: voc-p7109-01/author
reviewer: voc-e7109-01/evaluator
sha: b9208710c8f5cc70349503d564c7db398d5b2b77
tree: d8e9012ed0d371596f8044961a2a14a13ed737e3
---

## Reasons

7.109.01 is a patch: it fixes the product extract's refused schema and its fallback, and the review findings deferred from 7.104.00, with no new feature (CHANGELOG [7.109.01]: Changed, Fixed, Security and Upgrade notes only; the Changed bullets are a removed client-side filter, a test guard, an internal reuse and two docs notes). It is 7.108.01's patch, never released, applied onto 7.109.00 (an erasure lists for review the whole file an item came from, in every scope; it shares no code file with this patch: both edit the CHANGELOG, the registry, the six version files, the synth baseline, docs/multi-workspace.md and the nine components.json locales, at different sections, keys or rows, apart from the version bump and the synth baseline's regenerated hashes) and renumbered. Each fix carries its regression test; the four registered here prove the release's main fix (the extract's schema, its validation and its fallback) and the erasure's judging of a workspace project's product description and of the names of the sources an extract left out (a workspace's project holds a product description since 7.106.00).
