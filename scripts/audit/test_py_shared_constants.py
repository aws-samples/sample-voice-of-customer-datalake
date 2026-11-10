"""py_shared_constants reports copies that could share one home and stays quiet on coincidences and orphans."""
from __future__ import annotations

from audit_common import CDK_DIR
from py_bundles import Bundles
from py_shared_constants import census, findings, main

from conftest import TreeMaker

FILES = {
    'lambda/shared/__init__.py': '',
    'lambda/shared/keys.py': "TAG_PREFIX = 'METRIC#daily_tag#'\nRUN_QUEUED = 'queued'\n",
    # imports the owner AND copies a constant from it
    'lambda/agents/store.py': "from shared import keys\n\nRUN_QUEUED = 'queued'\n",
    # a writer/reader pair, the reader's copy under the same name
    'lambda/api/metrics_handler.py': "TAG_PREFIX = 'METRIC#daily_tag#'\nLIMIT = 200\nSTATUS = 'active'\n",
    # renamed but key-shaped: a regex
    'lambda/api/chat_handler.py': "import re\n_ID_RE = re.compile(r'^[a-z]{1,64}\\Z')\nMAX = 200\n",
    'lambda/shared/ids.py': "import re\nCONVERSATION_ID = re.compile(r'^[a-z]{1,64}\\Z')\n",
    # look-alikes: a renamed single word, and a copy in a stdlib-only bundle (no shared home)
    'lambda/jobs/retention.py': "STATE = 'active'\n",
    'lambda/product_doc_extractor/handler.py': "TAG_PREFIX = 'METRIC#daily_tag#'\n",
}
WITH_SHARED = frozenset({'Api/Metrics', 'Api/Chat', 'Proc/Agents', 'Proc/Retention'})


def _bundles() -> Bundles:
    shipped = {rel: WITH_SHARED for rel in FILES if not rel.startswith('lambda/product_doc_extractor/')}
    shipped['lambda/product_doc_extractor/handler.py'] = frozenset({'Core/Extractor'})
    modules = {rel: frozenset({rel.removeprefix('lambda/').removesuffix('.py').replace('/', '.')}) for rel in FILES}
    return Bundles(shipped, modules)


def test_planted_copies_are_found_and_look_alikes_are_not(make_tree: TreeMaker) -> None:
    root = make_tree(FILES)
    found = {f.key: f.kind for f in findings(census(root), _bundles())}
    assert found == {
        'RUN_QUEUED::lambda/agents/store.py,lambda/shared/keys.py': 'imported-already',
        'TAG_PREFIX::lambda/api/metrics_handler.py,lambda/shared/keys.py': 'same-name',
        'CONVERSATION_ID|_ID_RE::lambda/api/chat_handler.py,lambda/shared/ids.py': 'renamed',
    }


def test_the_real_tree_is_clean() -> None:
    assert main(['--cdk-dir', str(CDK_DIR)]) == 0
