"""Helpers for tests that mock `table.query`: read what a call asked for, so a mock can answer by key, not by
call order (handlers fan their reads out over parallel workers)."""


def partition_of(query_kwargs: dict) -> str:
    """The partition key value a mocked `table.query(KeyConditionExpression=...)` call names.

    Works for `Key('pk').eq(x) & <sort-key condition>` and for a bare `Key('pk').eq(x)`.
    """
    condition = query_kwargs['KeyConditionExpression']
    equals = condition.get_expression()['values'][0] if condition.expression_operator == 'AND' else condition
    return equals.get_expression()['values'][1]
