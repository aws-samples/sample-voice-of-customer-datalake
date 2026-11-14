"""Agent checkpoints: what a continuation restores from.

An agent saves a checkpoint as a create-only S3 put (``If-None-Match``) under its own keys in the workspace bucket
(voc-eng-workspace; its role may write nowhere else), in the workspace's layout (``workspace/layout.py``), under its
task's commit and attempt:
``ws/<ws>/runs/<run>/<agent>/commits/<sha>/_checkpoints/attempt-<n>/<seq:06d>-<nonce>.json``, a new object each
time, never overwritten. It holds plain JSON: ``position`` (the task and the step it reached), ``plan``, ``notes``
and ``patch`` (the S3 key of its working tree as a patch, under its own ``_patches/attempt-<n>/``). Never a token
or credential.

Before a continuation, the supervisor reads the agent's newest checkpoint and refuses one that is
over 256 KB, is not that shape, or holds a role session or a key that names a secret: the new
session then restores from the newest checkpoint that passes, or starts the task afresh.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any, Final

from engineering.connectors.identity import WORKSPACE
from engineering.runtime.interface import MAX_ATTEMPT, RuntimeRefused, check_id
from engineering.runtime.tokens import TokenNotStorable

#: The artifact kinds the runtime and the harness write, and a commit as the workspace's layout spells it (its one
#: home: workspace/layout.py takes it from here, since the images ship this module without layout.py and the bus
#: schema it imports); a test holds every key built here to ``layout.parse_agent_key``.
KINDS: Final = frozenset({'checkpoints', 'patches', 'gate'})
SHA: Final = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})\Z')
MAX_CHECKPOINT_BYTES: Final = 256 * 1024
#: Newest checkpoints tried, newest first, before a continuation starts afresh.
MAX_CANDIDATES: Final = 5
#: Key fragments a checkpoint never holds (case-insensitive).
SECRET_KEY_PARTS: Final = ('token', 'secret', 'password', 'credential', 'authorization', 'private_key')
REQUIRED_KEYS: Final = frozenset({'position'})


def assert_storable(value: object, path: str = 'checkpoint') -> None:
    """Refuse a value with a key that names a secret, at any depth (a ``RoleSession`` refuses serialising itself)."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            if any(part in str(key).lower() for part in SECRET_KEY_PARTS):
                raise TokenNotStorable(f'{path}.{key} names a secret; a checkpoint never holds one')
            assert_storable(item, f'{path}.{key}')
    elif isinstance(value, list | tuple):
        for index, item in enumerate(value):
            assert_storable(item, f'{path}[{index}]')


def agent_prefix(run_id: str, agent_id: str) -> str:
    """The agent's own keys in its run's workspace (``ws/<ws>/runs/<run>/<agent>/``): the only ones its role may
    write."""
    return f'ws/{WORKSPACE}/runs/{check_id("run_id", run_id)}/{check_id("agent_id", agent_id)}/'


def check_place(commit: str, attempt: int) -> None:
    """Refuse a commit that is not a full object id, or an attempt outside 1-``MAX_ATTEMPT``: where an agent's
    objects of its task go (its artifacts, and its outputs' shards: harness/role_tools.py)."""
    if not SHA.fullmatch(commit):
        raise RuntimeRefused('a commit is a full hexadecimal object id')
    if isinstance(attempt, bool) or not 0 < attempt <= MAX_ATTEMPT:
        raise RuntimeRefused(f'an attempt is 1-{MAX_ATTEMPT}')


def artifact_prefix(run_id: str, agent_id: str, commit: str, attempt: int, kind: str) -> str:
    """Where the agent's ``kind`` artifacts of its task's commit and attempt go (``workspace/layout.py``)."""
    check_place(commit, attempt)
    if kind not in KINDS:
        raise RuntimeRefused(f'an artifact here is one of {sorted(KINDS)}')
    return f'{agent_prefix(run_id, agent_id)}commits/{commit}/_{kind}/attempt-{attempt}/'


def checkpoint_prefix(run_id: str, agent_id: str, commit: str, attempt: int) -> str:
    return artifact_prefix(run_id, agent_id, commit, attempt, 'checkpoints')


def is_valid(body: bytes) -> bool:
    """A checkpoint the supervisor will hand to a continuation."""
    if len(body) > MAX_CHECKPOINT_BYTES:
        return False
    try:
        state = json.loads(body)
        assert_storable(state)
    except (ValueError, TokenNotStorable):
        return False
    return isinstance(state, dict) and state.keys() >= REQUIRED_KEYS


class CheckpointReader:
    def __init__(self, s3: Any, bucket: str) -> None:
        self._s3 = s3
        self._bucket = bucket

    def latest(self, run_id: str, agent_id: str, commit: str, attempt: int) -> str | None:
        """The key of the agent's newest valid checkpoint of its task's attempt, or None (the task starts afresh)."""
        sizes: dict[str, int] = {}
        for page in self._s3.get_paginator('list_objects_v2').paginate(
                Bucket=self._bucket, Prefix=checkpoint_prefix(run_id, agent_id, commit, attempt)):
            sizes.update((str(item['Key']), int(item.get('Size', 0))) for item in page.get('Contents', []))
        for key in sorted(sizes, reverse=True)[:MAX_CANDIDATES]:
            # The agent writes these objects: one too big is never read (the supervisor's memory is every run's).
            if sizes[key] > MAX_CHECKPOINT_BYTES:
                continue
            body = self._s3.get_object(Bucket=self._bucket, Key=key)['Body'].read(MAX_CHECKPOINT_BYTES + 1)
            if is_valid(body):
                return key
        return None
