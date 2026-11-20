"""voc-retention (7.62.00): an erasure by email lists the Documents Library items that hold the address for review,
in the deployment's library and in a workspace's (jobs/retention/project_people.py ``_library_item``), and never
changes one (TENETS.md D5; docs/documents-library.md "Erasure")."""
from __future__ import annotations

from typing import Any

from jobs.retention.test.conftest import BUCKET, erasure_rows
from jobs.retention.test.test_project_erasure import REVIEWER, _erase_by_email, _list_workspace
from jobs.retention.test.test_workspace_erasure import JOB_ID, WS
from shared.library_keys import extracted_key, item_key, original_key
from shared.ws_repo import WorkspaceScope

A = WorkspaceScope(WS)
HOLDS, SAYS_NOTHING, NAMED, PENDING, UNREADABLE = (f'lib_20261101000000_0000000{n}' for n in range(1, 6))


def _item(aws, item_id: str, scope: WorkspaceScope | None, *, text: str | None, status: str = 'ready',
          **fields: Any) -> None:
    aws['projects'].put_item(Item={**item_key(item_id, workspace=scope), 'item_id': item_id, 'status': status,
                                   'title': 'Market report', 'filename': 'report.pdf', 'tags': ['market'], **fields})
    if text is not None:
        aws['s3'].put_object(Bucket=BUCKET, Key=extracted_key(item_id, workspace=scope), Body=text.encode())


def test_items_that_hold_the_address_are_listed_and_nothing_changes(aws, worker_context):
    _list_workspace(aws, WS, 'Alpha')
    _item(aws, HOLDS, None, text=f'Interview with {REVIEWER.upper()} about pricing')
    _item(aws, SAYS_NOTHING, None, text='Nothing personal here')
    _item(aws, NAMED, A, text='Nothing here', tags=['market', REVIEWER])
    _item(aws, PENDING, A, text=None, status='pending')
    _item(aws, UNREADABLE, A, text=None)
    before = sorted(str(row) for row in aws['projects'].scan()['Items'])

    _erase_by_email(aws, worker_context)

    job, audit = erasure_rows(aws, JOB_ID)
    assert sorted(job['files_needing_review']['keys']) == sorted(audit['files_needing_review']['keys']) == sorted([
        original_key(HOLDS), original_key(NAMED, workspace=A)])
    assert sorted(job['files_not_checked']['keys']) == sorted([original_key(PENDING, workspace=A),
                                                               original_key(UNREADABLE, workspace=A)])
    library_rows = sorted(str(row) for row in aws['projects'].scan()['Items'] if 'item_id' in row)
    assert library_rows == sorted(row for row in before if "'item_id'" in row)

