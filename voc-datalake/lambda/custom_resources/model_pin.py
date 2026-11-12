"""Deploy-time seed for the deployment's default model (``SETTINGS#model_default`` / ``config``, ``model_id``).

Why this exists
--------------
Some accounts cannot invoke the newest Claude models. Workshop Studio events in
particular sit behind an AWS Private Marketplace that refuses
``CreateFoundationModelAgreement`` for Sonnet 5 / Opus 5, while Sonnet 4.6 and
Haiku 4.5 work. Those events are fully automated: nobody can open Settings and
pick a model per participant account, so the choice has to be made at deploy
time.

How it works
------------
``shared/model_config.py`` resolves a surface's model as::

    explicit argument
    > per-surface override (settings.surfaces[S])
    > legacy global override (settings.model_id)
    > the deployment's default (SETTINGS#model_default)   <- what this writes
    > built-in SURFACE_DEFAULTS[S]
    > BEDROCK_MODEL_ID

Writing it repoints **every** surface an admin did not pick for (the TypeScript
streaming-chat lookup in ``lambda/stream/src/bedrock/model-override.ts`` and the
product-doc extractor honour the same precedence). No change to
``SURFACE_DEFAULTS`` is needed, so deployments that can use the newer models are
unaffected. It is a row of its own, not the picks' row, so the picks can move
into each workspace while the default stays the deployment's
(docs/multi-workspace.md, "Per-workspace configuration"). A deployment from
before that split keeps its earlier pin in ``settings.model_id``, which still
outranks this row, so nothing changes for it.

Create-once, like the sibling admin bootstrap: the write is conditional on
``model_id`` being absent, so a redeploy never changes it. It is a floor, not a
lock: every admin pick outranks it.
"""
import logging

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MODEL_DEFAULT_PK = 'SETTINGS#model_default'
MODEL_DEFAULT_SK = 'config'

PHYSICAL_ID = 'voc-model-pin'


def handler(event, _context):
    """Seed the deployment's default model unless it is already set.

    Raises on unexpected failures: a silent no-op would leave the deployment
    green while every AI surface resolves to a model the account cannot
    invoke, which is far harder to diagnose than a failed stack.
    """
    request_type = event.get('RequestType')
    props = event.get('ResourceProperties', {})
    model_id = props.get('ModelId', '')
    # Both arrive as resource properties from core-stack.ts. Deliberately no
    # AGGREGATES_TABLE env fallback: nothing sets that variable on this
    # function, and the fallback would mask a missing property (it silently
    # absorbed one in tests, where lambda/conftest.py defines it).
    table_name = props.get('TableName', '')

    if request_type == 'Delete':
        # Leave the setting in place; deleting the stack should not silently
        # repoint a still-running app, and the table goes with it anyway.
        return {'PhysicalResourceId': PHYSICAL_ID, 'Data': {'outcome': 'skipped'}}

    if not model_id or not table_name:
        raise ValueError(f'ModelId and TableName are required (got {model_id!r}, {table_name!r})')

    table = boto3.resource('dynamodb').Table(table_name)
    try:
        table.update_item(
            Key={'pk': MODEL_DEFAULT_PK, 'sk': MODEL_DEFAULT_SK},
            UpdateExpression='SET model_id = :m',
            ConditionExpression='attribute_not_exists(model_id)',
            ExpressionAttributeValues={':m': model_id},
        )
        logger.info(f"Pinned the deployment's default model to {model_id}")
        outcome = 'pinned'
    except table.meta.client.exceptions.ConditionalCheckFailedException:
        # Already pinned by a previous deploy.
        logger.info(f'model_id already set; leaving it untouched (wanted {model_id})')
        outcome = 'kept'

    return {'PhysicalResourceId': PHYSICAL_ID, 'Data': {'outcome': outcome, 'modelId': model_id}}
