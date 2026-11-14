"""The shapes of an agent's outputs, in one home the harness and the readers share.

The harness ships alone in the agents' images (engineering-images: no reader's module goes with it), and its
``role_tools`` write these outputs; the readers take the same values from here: a ``voc-finding/1`` line
(workspace/findings.py), a ``voc-note/1`` line (knowledge/notes.py), a ``voc-gate-record/1`` record and its verdicts
and severities (quality_gate/record.py, review.py), a package path as one workspace key segment
(workspace/layout.py), the agents' branch prefix (connectors/write_policy.py), and a submitted patch's key and the
broker's size bound for it (connectors/patches.py: the gate judges only a patch the broker would read). Pure: the
standard library only.
"""
from __future__ import annotations

import re
from typing import Final

FINDING_SCHEMA: Final = 'voc-finding/1'
NOTE_SCHEMA: Final = 'voc-note/1'
GATE_SCHEMA: Final = 'voc-gate-record/1'
SEVERITIES: Final = ('blocking', 'should_fix', 'nit')
#: The seven documents of a knowledge pack, in the order they are rendered (docs/autonomous-engineering.md's table).
NOTE_KINDS: Final = ('architecture', 'convention', 'review-guide', 'test-strategy', 'ci', 'glossary', 'how-we-work')
GATE_VERDICTS: Final = frozenset({'GO', 'NO-GO', 'STOPPED'})
#: A finding's file: a repository path of path characters only (no spaces, no ``@`` of an e-mail address), so a
#: ``file`` cannot carry text.
FINDING_FILE: Final = re.compile(r'[A-Za-z0-9_./+-]{1,300}\Z')
#: The branches an agent's push may name: ``voc-agent/<run id>/<name>``.
AGENT_BRANCH_PREFIX: Final = 'voc-agent/'
#: A gate record's plain names (a gate pack's, a reviewer's) and a STOPPED record's reason, as the harness writes
#: them and quality_gate/record.py reads them back.
PLAIN_NAME: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z')
STOP_REASON: Final = re.compile(r'[a-z_]{0,40}\Z')
#: A patch a fixer or builder submitted (``submit_work``): the one the gate judges and the committer pushes. Never a
#: checkpoint's snapshot (connectors/patches.py takes the same keys for the committer's push).
SUBMITTED_PATCH: Final = re.compile(r'ws/default/runs/(?P<run>[A-Za-z0-9_-]{1,64})/(?:fixer|builder)-[0-9]{1,3}/'
                                    r'commits/(?P<commit>[0-9a-f]{40}|[0-9a-f]{64})/_patches/attempt-[1-9][0-9]{0,3}/'
                                    r'(?P<name>[A-Za-z0-9][A-Za-z0-9_.-]{0,122}\.diff)\Z')
#: The largest submitted patch the broker reads, and so the largest the gate judges.
MAX_SUBMITTED_PATCH_BYTES: Final = 6 * 1024 * 1024
_PLAIN: Final = re.compile(rb'[A-Za-z0-9_-]')


def is_submitted_patch(key: str, run_id: str, commit: str) -> bool:
    """Whether ``key`` is a patch a fixer or builder of run ``run_id`` submitted at ``commit``: the one the gate
    judges (harness/role_tools.py) and the broker pushes for the committer (connectors/patches.py)."""
    match = SUBMITTED_PATCH.fullmatch(key)
    return (match is not None and match.group('run') == run_id and match.group('commit') == commit
            and not match.group('name').startswith('checkpoint-'))


def encode_package(package: str) -> str:
    """A package path as one key segment (workspace/layout.py checks and decodes it): every UTF-8 byte outside
    ``[A-Za-z0-9_-]`` as ``=XX``, and a leading ``_`` too (only the artifact kinds begin with one)."""
    return ''.join(chr(byte) if _PLAIN.fullmatch(bytes([byte])) and not (i == 0 and byte == ord('_'))
                   else f'={byte:02X}' for i, byte in enumerate(package.encode()))
