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

from engineering.board.api import repost_task
from engineering.board.store import BoardStore
from engineering.knowledge.store import PackStore, PackVersion
from engineering.knowledge.understand import understand_package
from engineering.skills.store import Change, SkillStore, SkillVersion, VersionPage

# The Understand flow's entry, run by the mapper agent in its MicroVM; the agent lands in phase 4
# (docs/autonomous-engineering.md), its tests drive it until then.
understand_package.__name__

# PackStore.for_agent: the one read of a pack for an agent's prompt (its documents fenced as data); the agents that
# call it land in phase 4. PackVersion's D4 record of who wrote and approved a version, read back for the pack's
# admin REST reads (planned with the Understand flow).
PackStore.for_agent
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

# The supervisor's re-post of a task (board/api.py): the runtime's Board.repost port (engineering/runtime/ports.py)
# is to call it; the board's tests drive it until it is wired.
repost_task.__name__

# The run's coordinate task (board/store.py): the runtime's RunStore.start is to put its items in the start
# transaction; the board's tests drive it until it is wired.
BoardStore.coordinate_items
# The supervisor's renewal of a holder's lease before it continues the agent (BoardStore.refresh): the runtime's
# Board port is to call it.
BoardStore.refresh
# A new run coordinator on the coordinate task (BoardStore.launch_coordinator): the runtime's Resume of a run whose
# coordinator is gone is to call it (voc-auto-b's); the board's tests drive it until it is wired.
BoardStore.launch_coordinator
