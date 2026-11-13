"""vulture's whitelist: seams production defines before the code that calls them lands, each named exactly.

vulture reads this file as one of its paths (pyproject.toml [tool.vulture] ``paths`` holds ``scripts``, and
scripts/lint-python.sh runs both of its passes over it), so every attribute named here counts as used. Nothing runs
it; pyright checks it, so an entry whose class or attribute is renamed or removed fails the type check instead of
going stale. Its lines are bare attribute reads, vulture's whitelist format (ruff.toml exempts this one file from
B018). vulture matches by name: an entry keeps every definition of that name, which is why the methods below have
names no other code defines (``propose_version``, not ``propose``). Each group says why it is here and when it
leaves.
"""
from __future__ import annotations

from engineering.agent_memory.recall import Recall
from engineering.agent_memory.store import AgentMemoryStore
from engineering.benchmark.cases import load_suite
from engineering.benchmark.runner import Scorecard, run_suite
from engineering.knowledge.store import PackVersion
from engineering.knowledge.understand import understand_package
from engineering.skills.store import Change, SkillStore, SkillVersion, VersionPage

# The Understand flow's entry, run by the mapper agent in its MicroVM; the agent lands in phase 4
# (docs/autonomous-engineering.md), its tests drive it until then.
understand_package.__name__

# PackVersion's D4 record of who wrote and approved a version, read back for the pack's admin REST reads (planned
# with the Understand flow).
PackVersion.author_kind
PackVersion.approved_by
PackVersion.approved_at

# The skills store, read by the harness and the coach, whose entry points land with phase 4's agents and phase 5's
# routes; its tests drive it until then. SkillVersion's D4 record of who proposed, accepted or rejected a version,
# the announcement each change returns for the bus, and the history's page cursor.
SkillStore.propose_version
SkillStore.accept_version
SkillStore.reject_version
SkillStore.promote_version
SkillStore.roll_back_to
SkillStore.promotion_source
SkillVersion.proposed_by
SkillVersion.proposed_by_kind
SkillVersion.accepted_at
SkillVersion.rejected_by
SkillVersion.rejected_at
Change.announcement
VersionPage.next_after

# The benchmark (engineering/benchmark/): a suite loaded and a candidate scored on it, and the gate's verdict recorded
# on the version (SkillStore.record_benchmark), by the benchmark step the coach's proposals go through, which lands
# with the coach (phase 3) and its administrators' routes (phase 5); the benchmark's tests drive them on the shipped
# cases until then. Scorecard.total_cost_usd: a candidate's cost on the suite, for the scorecards (phase 5).
load_suite.__name__
run_suite.__name__
Scorecard.total_cost_usd
SkillStore.record_benchmark
# The pass rates a version's readers (the skill history, phase 5) show: the recorded benchmark's, else the claim.
SkillVersion.trusted_rates

# The agents' memory store, written by the agents' learning (the learning loop, phase 5), read by the harness's
# recall for a task (phase 4's agents) and approved, edited, forgotten and restored through the people's and the
# administrators' routes (phase 5), and erased by the platform's erasure of a person (not wired yet); its tests drive
# it until then. Recall.left_out: how many applicable memories the bounds left out, for the run journal.
AgentMemoryStore.erase_person_memories
AgentMemoryStore.learn_agent_memory
AgentMemoryStore.write_agent_memory
AgentMemoryStore.confirm_agent_memory
AgentMemoryStore.approve_agent_memory
AgentMemoryStore.edit_agent_memory
AgentMemoryStore.forget_agent_memory
AgentMemoryStore.restore_agent_memory
AgentMemoryStore.agent_memory_history
AgentMemoryStore.pending_agent_memories
AgentMemoryStore.recall_for_task
Recall.left_out
