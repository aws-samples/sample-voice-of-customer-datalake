"""Deploy-time seed of the review registries' marker on a deployment with no project yet (7.93.00, 3g-d2;
lib/stacks/review-registries-marker.ts, which runs it right after the marker's reset; docs/deployment.md).

Since 7.93.00 an erasure by email needs the backfill's marker (scripts/projects/backfill_review_registries.py). A
new deployment has nothing to backfill, so on Create this looks for one project on ``gsi1-by-type`` (``Limit`` 1,
keys only) and, finding none, writes a complete marker (each count 0, the deployed release). Finding one (an upgrade,
or a release added again after a rollback below 7.48.00) it writes nothing: the operator's backfill does. A
project made before 7.48.00 and since deleted, on a deployment with no live project, is not seen (a deleted project
is off the index and was never listed, its threads are not): docs/deployment.md says to run the backfill on every
upgrade from below 7.48.00, and to take the dry run before the deploy on one from 7.48.00 or later. A fixture project
counts as one (no marker: erasures fail by name). Update (each release) and Delete
do nothing; a failure raises (a green stack whose erasures fail is harder to see than a failed deploy).
"""
import logging
from datetime import UTC, datetime

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

#: The marker's key and counts: a test holds each to the Python stores'. The index and its partition come from the
#: stack (``IndexName``, ``Partition``: the ones its policy allows).
MARKER_PK = 'DOCSHARE_IDS'
MARKER_SK = 'MIGRATION#review-registries'
MARKER_COUNTS = ('links_found', 'series_found', 'projects_found')
_REQUIRED = ('TableName', 'IndexName', 'Partition', 'Release')

PHYSICAL_ID = 'voc-review-registries-marker-seed'


def handler(event, _context):
    """On Create, the complete marker when the deployment has no project; else, and on Update and Delete, nothing."""
    if event.get('RequestType') != 'Create':
        return {'PhysicalResourceId': PHYSICAL_ID, 'Data': {'outcome': 'skipped'}}
    props = event.get('ResourceProperties', {})
    if missing := [name for name in _REQUIRED if not props.get(name)]:
        raise ValueError(f'{", ".join(_REQUIRED)} are required (missing {", ".join(missing)})')
    table = boto3.resource('dynamodb').Table(props['TableName'])
    if has_a_project(table, props['IndexName'], props['Partition']):
        logger.info('The deployment has projects: the backfill writes the review registries marker')
        outcome = 'left_to_the_backfill'
    else:
        outcome = 'marked' if put_marker(table, props['Release']) else 'kept'
        logger.info(f'The deployment has no project: review registries marker {outcome}')
    return {'PhysicalResourceId': PHYSICAL_ID, 'Data': {'outcome': outcome}}


def has_a_project(table, index, partition):
    """Whether the index's ``partition`` names any deployment project: one Query, ``Limit`` 1, the keys only."""
    answer = table.query(
        IndexName=index,
        KeyConditionExpression='#p = :p',
        ProjectionExpression='#pk, #sk',
        ExpressionAttributeNames={'#p': 'gsi1pk', '#pk': 'pk', '#sk': 'sk'},
        ExpressionAttributeValues={':p': partition},
        Select='SPECIFIC_ATTRIBUTES',
        Limit=1,
    )
    return bool(answer.get('Items'))


def put_marker(table, release):
    """The complete marker, unless one is there already (never overwritten); False when it was."""
    marker = {'pk': MARKER_PK, 'sk': MARKER_SK, 'completed_at': datetime.now(UTC).isoformat(),
              **dict.fromkeys(MARKER_COUNTS, 0), 'release': release}
    try:
        table.put_item(Item=marker, ConditionExpression='attribute_not_exists(pk)')
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        return False
    return True
