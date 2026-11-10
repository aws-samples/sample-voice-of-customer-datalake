"""Guard test: every example of a web_reviews source label matches `web_review_source_id`.

The assistant cannot import Python, so its planner rules (`plan.ts`), its guidance
(`guidance.ts`), the `create_app_connector` description (`scrapers.ts`) and the docs
spell the label out by example: app_name "Example Air" on a Trustpilot page is
`web_trustpilot_example_air`. A planner told the wrong label scopes a persona or PR/FAQ
job to a source that holds no reviews, so a drifted example fails here.
"""
import re

import pytest

from shared.test.repo_paths import repo_root
from shared.web_review_targets import web_review_source_id

MIRRORS = (
    'lambda/stream/src/assistant/tools/server/plan.ts',
    'lambda/stream/src/assistant/tools/guidance.ts',
    'lambda/stream/src/assistant/tools/client/scrapers.ts',
    '../docs/web-reviews.md',
    '../docs/assistant-plan-mode.md',
)
# app_name "Example Air" on [a] [https://]www.trustpilot.com[/path] [page] is [sources ["]web_…
EXAMPLE_RE = re.compile(
    r'app_name\s+"(?P<name>[^"]+)"\s+on\s+(?:an?\s+)?(?:https://)?(?P<host>[a-z0-9.-]+)\S*\s+(?:page\s+)?'
    r'is\s+(?:sources\s+\[")?`?(?P<id>web_[a-z0-9_-]+)'
)
# A TypeScript string continued on the next line: `'… on '` newline `+ 'https://…'`.
CONTINUATION_RE = re.compile(r"""['`]\s*\n\s*\+\s*['`]""")


@pytest.mark.parametrize('path', MIRRORS)
def test_every_example_label_is_the_minted_one(path: str):
    text = CONTINUATION_RE.sub('', (repo_root() / path).read_text(encoding='utf-8'))
    examples = [match.groupdict() for match in EXAMPLE_RE.finditer(text)]
    assert examples, f'{path} no longer shows a web_reviews source example'
    for example in examples:
        assert web_review_source_id(example['host'], example['name']) == example['id'], example
