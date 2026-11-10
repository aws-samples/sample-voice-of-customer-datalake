"""doc_contract reports each planted doc drift and stays quiet on the legitimate look-alikes."""
from __future__ import annotations

import pytest
from audit_common import REPO, AuditError
from doc_contract import main, scan

from conftest import TreeMaker

HANDLERS = {f'voc-datalake/lambda/api/{n}_handler.py': f"@app.get('/{n}')\ndef h(): ...\n"
            for n in ('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta')}
LOGS = "@app.get('/logs/summary')\ndef s(): ...\n@app.delete('/logs/validation/<source>')\ndef d(): ...\n"
STACK = "const chat = api.root.addResource('chat');\nchat.addResource('stream').addMethod('POST', i);\n"
GUIDE = '''# Guide

## Setup steps

See [setup](#setup-steps), [the other doc](other.md#usage), [gone](missing.md) and [no anchor](other.md#nope).
Read `voc-datalake/lambda/api/alpha_handler.py`, `lambda/api/beta_handler.py` and `lambda/stream/src/lib/x.ts`.
The old `lambda/ingestors/` folder was removed. Prefixes like `raw/` and `api/projects/{id}.json` are not paths.
Cites `notes.md` and `other.md`.

```
`not/judged/inside/a/fence.ts` | GET | `/fenced` |
```

| Method | Path | What |
|---|---|---|
| GET | `/logs/summary` | served |
| GET | `/logs/errors` | not served |
| DELETE | `/logs/validation/{source}` | served (any parameter name) |
| POST | `/chat/stream` | an explicit gateway method |
| ANY | `/memory/{proxy+}` | a proxy row needs some route below it |
| GET / PUT | `/alpha` | served for GET only |
'''
LIST = ('Handlers: alpha_handler.py, beta_handler.py, gamma_handler.py, delta_handler.py, epsilon_handler.py, '
        'logs_handler.py, omega_handler.py.\n')
OTHER = '# Other\n\n## Usage\n\nNothing here.\n'


def _tree(make_tree: TreeMaker):
    return make_tree({**HANDLERS, 'voc-datalake/lambda/api/logs_handler.py': LOGS,
                      'voc-datalake/lambda/api/memory_handler.py': "@app.get('/memory/stats')\ndef m(): ...\n",
                      'voc-datalake/lib/stacks/api-routes.ts': STACK,
                      'voc-datalake/lambda/stream/src/bedrock/x.ts': '', 'voc-datalake/frontend/mock-coverage.json': '[]',
                      'docs/guide.md': GUIDE, 'docs/other.md': OTHER, 'docs/list.md': LIST})


def test_every_kind_is_reported_on_its_planted_instance(make_tree: TreeMaker) -> None:
    found, _ = scan(_tree(make_tree))
    assert sorted(f.key for f in found) == [
        'docs/guide.md::broken-link::missing.md',
        'docs/guide.md::broken-link::other.md#nope',
        'docs/guide.md::missing-path::lambda/stream/src/lib/x.ts',
        'docs/guide.md::route-not-served::GET /logs/errors',
        'docs/guide.md::route-not-served::GET/PUT /alpha',
        'docs/guide.md::uncited-file::notes.md',
        'docs/list.md::handler-list::extra:omega_handler.py',
        'docs/list.md::handler-list::missing:memory_handler.py',
        'docs/list.md::handler-list::missing:zeta_handler.py',
    ]


def test_a_partial_list_is_not_asked_to_be_complete(make_tree: TreeMaker) -> None:
    root = _tree(make_tree)
    (root / 'docs' / 'list.md').write_text('Some: alpha_handler.py, beta_handler.py, gamma_handler.py, delta_handler.py, '
                                           'epsilon_handler.py.\n', encoding='utf-8')
    found, _ = scan(root)
    assert [f.key for f in found if f.kind == 'handler-list'] == []


def test_a_tiny_tree_trips_the_vacuity_guard(make_tree: TreeMaker) -> None:
    with pytest.raises(AuditError, match='vacuity'):
        main(['--root', str(_tree(make_tree))])


def test_the_real_tree_is_clean() -> None:
    assert main(['--root', str(REPO)]) == 0


def test_root_ignored_notes_are_neither_scanned_nor_counted(make_tree: TreeMaker) -> None:
    root = _tree(make_tree)
    (root / '.gitignore').write_text('/docs/pending*.md\n/*-audit*.md\n', encoding='utf-8')
    (root / 'docs' / 'pending.md').write_text('[gone](missing.md)\n', encoding='utf-8')
    (root / 'docs' / 'code-audit.md').write_text('# Audit\n', encoding='utf-8')   # `/*-audit*.md` is root-only
    (root / 'docs' / 'other.md').write_text(OTHER + 'See [audit](code-audit.md) and `pending.md`.\n', encoding='utf-8')
    found, _ = scan(root)
    keys = {f.key for f in found}
    assert not any(k.startswith('docs/pending.md') for k in keys)
    assert 'docs/other.md::uncited-file::pending.md' in keys
    assert not any(k.startswith('docs/other.md::broken-link') for k in keys)
