"""Literals shared by the two line slices of the `api/projects.py` mutation suite.

`test_projects_mutation_1266_2671.py` and `test_projects_mutation_2672_3893.py`
harden one module in two halves; the persona they build and the persona they
update carry the same nested sections, so those sections are spelled once here
and each suite adds only the fields its half of the module owns.
"""
from __future__ import annotations

# The six persona sections `build_persona_items` copies through and `update_persona` aliases,
# each holding one marker value so a dropped or renamed field is a visible diff.
PERSONA_SECTIONS: dict[str, object] = {
    'goals_motivations': {'g': 1},
    'pain_points': {'p': 1},
    'behaviors': {'b': 1},
    'context_environment': {'c': 1},
    'quotes': ['q'],
    'scenario': {'s': 1},
}
