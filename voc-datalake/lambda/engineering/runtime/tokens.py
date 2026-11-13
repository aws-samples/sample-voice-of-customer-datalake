"""What is never stored: a credential refuses to be serialised.

The launcher's role session (``launcher.RoleSession``) lives only in the memory of the function that assumed it and
in the agent's session, where its runner keeps it for the agent user: it has no readable ``repr`` and refuses to be
pickled, and ``checkpoints.py`` refuses any state that holds a key naming a secret.
"""
from __future__ import annotations


class TokenNotStorable(TypeError):
    """Something tried to serialise a credential."""
