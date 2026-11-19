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
