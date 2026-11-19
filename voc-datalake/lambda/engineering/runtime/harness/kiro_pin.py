"""The Kiro CLI's pin, shared by both sides of the Kiro switch (7.53.00): the harness in each agent image
(``kiro.py``, which checks the installed CLI) and the Lambdas that launch an agent on it or check that it can
run (``runtime/harness_switch.py``, ``readiness_aws.py``). Standard library only, so the Lambdas that import it
never load the image-only harness."""
from __future__ import annotations

import re
from typing import Final

#: The one kiro-cli the images install (templates/orchestration/images/common/install-kiro.sh, at its published
#: sha256), and the version the harness accepts (``kiro.check``; the launch's argv names it: runtime/harness_switch.py).
KIRO_CLI_VERSION: Final = '3.4.0'
#: The deployment's key parameter: ``/voc/engineering/_kiro/api-key``, or ``/<prefix>-voc/…`` on a prefixed one.
KEY_PARAMETER_RE: Final = re.compile(r'/(?:[a-z0-9][a-z0-9-]{0,40}-)?voc/engineering/_kiro/api-key\Z')
#: A Claude model's Bedrock id (``global.anthropic.claude-sonnet-5-5``, ``…claude-haiku-4-5-20251001-v1:0``): its family,
#: its major and its minor version.
CLAUDE_MODEL_RE: Final = re.compile(
    r'(?:[a-z]+\.)?anthropic\.claude-(opus|sonnet|haiku)-(\d+)(?:-(\d))?(?:-\d{8}-v\d+:\d+)?\Z')
#: (7.58.00) The named model choices (``model_choice.py``) by Kiro's names: ``auto`` is Kiro choosing per task.
KIRO_CHOICES: Final = {'auto': 'auto', 'opus': 'claude-opus-5.5', 'sonnet': 'claude-sonnet-5.5',
                       'haiku': 'claude-haiku-5.5'}


def kiro_model(model_id: str, *, chosen: bool = False) -> str | None:
    """Kiro's name for the Claude model ``model_id`` names (``claude-sonnet-5.5``, as ``kiro-cli chat --list-models``
    lists it), so a session on Kiro runs the model its skill names rather than Kiro's default (``auto``, a model
    Kiro picks per task); None for any other model. A model a person chose (7.58.00, ``chosen``: a model choice) is
    also a named choice's Kiro name, or else any other id as it is (another model: Kiro checks it when the session
    starts); None for none."""
    if chosen and model_id in KIRO_CHOICES:
        return KIRO_CHOICES[model_id]
    found = CLAUDE_MODEL_RE.fullmatch(model_id)
    if found is None:
        return (model_id or None) if chosen else None
    family, major, minor = found.groups()
    return f'claude-{family}-{major}' + (f'.{minor}' if minor else '')
