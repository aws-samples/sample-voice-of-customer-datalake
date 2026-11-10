"""AWS doubles shared by the product-context test modules.

`product_context.generate_report` saves through `transact_write_items` on the
table's client. A MagicMock table would swallow that silently, so
`test_product_report_single_read.py` and `test_product_report_derivation.py`
replay each action onto the table's own `put_item` / `update_item`, where their
assertions read it. `s3_serving` is the extracted-text bucket those modules (and
`test_visual_brief.py`) read product documents from.
"""
from unittest.mock import MagicMock


def wire_transactions(table: MagicMock) -> None:
    """Name `table` and replay every transaction's Put and Update onto it."""
    table.name = 'test-projects'

    def transact_write_items(*, TransactItems):
        for action in TransactItems:
            put = action.get('Put')
            if put:
                table.put_item(Item=put['Item'])
            update = action.get('Update')
            if update:
                table.update_item(
                    Key=update['Key'],
                    UpdateExpression=update['UpdateExpression'],
                    ExpressionAttributeValues=update.get(
                        'ExpressionAttributeValues', {},
                    ),
                )
        return {}

    table.meta.client.transact_write_items.side_effect = transact_write_items


def s3_serving(bodies: dict[str, str]) -> MagicMock:
    """An S3 client whose `get_object` answers `bodies[Key]`, UTF-8 encoded.

    Keyed by S3 key, so a body cannot be attributed to the wrong document; an
    unknown key raises KeyError rather than answering something plausible.
    """
    def get_object(*, Key, **_kwargs):  # boto3's own capitalised kwarg
        payload = bodies[Key].encode('utf-8')
        body = MagicMock()
        body.read.return_value = payload
        return {'Body': body}

    s3 = MagicMock()
    s3.get_object.side_effect = get_object
    return s3
