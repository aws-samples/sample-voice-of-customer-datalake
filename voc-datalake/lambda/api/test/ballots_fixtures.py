"""In-memory aggregates-table machinery shared by the two ballot test modules.

`test_ballots_handler.py` (the anonymous room ballot) and
`test_projects_prioritization_ballots.py` (the signed-in reviewer ballot) both run
a route that writes to the aggregates table through conditional updates and a
`transact_write_items` on the resource's client. Each keeps its OWN fake, because
the two routes write different expressions and each fake implements exactly the
ones its route writes and nothing more. What they share lives here:

  * `split_top_level`, the comma split a `SET` clause needs;
  * `ConditionalFakeTable`, the call recording, the conditional `update_item`, the
    `SET` / `ADD` application and the all-or-nothing transaction. A subclass says
    which conditions it understands (`_holds`), which transaction operations it
    accepts, and how strictly it resolves a name or a value;
  * the `ClientError` shapes the fakes and the tests raise, and the wrappers that
    make one kind of call on a fake fail.

Nothing here computes an expected value; the tests' expectations stay literal.
"""
from types import SimpleNamespace

from botocore.exceptions import ClientError


def split_top_level(text, separator=','):
    """Split on `separator` outside parentheses.

    `if_not_exists(#frozen_at, :now)` carries a comma of its own, so a naive split
    of a `SET` clause tears that call in half — and a fake that mis-parsed it would
    report an update the route never made.
    """
    parts, depth, current = [], 0, ''
    for char in text:
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
        if char == separator and depth == 0:
            parts.append(current)
            current = ''
            continue
        current += char
    parts.append(current)
    return [part.strip() for part in parts if part.strip()]


def conditional_check_failed(operation):
    """The error DynamoDB raises when a single-item write's condition fails."""
    return ClientError(
        {'Error': {'Code': 'ConditionalCheckFailedException',
                   'Message': 'The conditional request failed'}},
        operation,
    )


def cancelled_transaction(reasons):
    """A `TransactionCanceledException` carrying the given per-item reasons.

    Positional and one entry per item, with `'None'` for the items that did not
    fail, which is DynamoDB's own shape — verified against moto, whose reasons for a
    two-item transaction failing on the second read
    `[{'Code': 'None'}, {'Code': 'ConditionalCheckFailed', ...}]`.
    """
    return ClientError(
        {'Error': {'Code': 'TransactionCanceledException',
                   'Message': 'Transaction cancelled'},
         'CancellationReasons': list(reasons)},
        'TransactWriteItems',
    )


def _fail_matching(table, method, matches, code, operation):
    """Replace `table.<method>` so a call `matches` accepts raises `code`; every
    other call goes through to the real fake. A fresh error per call, as boto3's."""
    real = getattr(table, method)

    def failing(**kwargs):
        if matches(kwargs):
            raise ClientError({'Error': {'Code': code}}, operation)
        return real(**kwargs)

    setattr(table, method, failing)
    return table


def throttle_row_reads(table):
    """Every `get_item` of a `ROW#` record is throttled; other reads still answer."""
    return _fail_matching(
        table, 'get_item', lambda kwargs: str(kwargs['Key']['sk']).startswith('ROW#'),
        'ProvisionedThroughputExceededException', 'GetItem',
    )


def fail_updates_of(table, sort_key, code='ProvisionedThroughputExceededException'):
    """Every `update_item` on `sort_key` raises `code`; other updates still land."""
    return _fail_matching(
        table, 'update_item', lambda kwargs: kwargs['Key']['sk'] == sort_key,
        code, 'UpdateItem',
    )


class ConditionalFakeTable:
    """The part of an in-memory aggregates table both ballot fakes share.

    CONDITIONS ARE ENFORCED, never ignored: `_holds` is the subclass's evaluator,
    and it must raise on a form it does not understand rather than treat it as true,
    so a new conjunct cannot pass unnoticed.

    The TRANSACTION is all-or-nothing as it is in DynamoDB — every condition is
    evaluated before any item is applied — because that is the property the ballot
    write depends on: the ballot and its row's freeze mark land together or neither
    does, and a fake that applied items as it walked them would let a test about
    that pass against code that wrote one without the other.
    """

    # The transaction operations the subclass's route issues; anything else asserts.
    TRANSACT_OPERATIONS = ('Update',)

    def __init__(self, items=None):
        self.items = {(i['pk'], i['sk']): dict(i) for i in (items or [])}
        self.get_item_calls = []
        self.put_item_calls = []
        self.update_item_calls = []
        self.transact_calls = []
        # `table.name` and `table.meta.client` are what a transaction needs: it is
        # issued on the resource's underlying CLIENT, which takes the table name per
        # item rather than being bound to one table.
        self.name = 'test-aggregates'
        self.meta = SimpleNamespace(client=SimpleNamespace(
            transact_write_items=self._transact_write_items,
        ))

    # -- what a subclass decides --------------------------------------------
    def _holds(self, condition, item, names, values):
        raise NotImplementedError

    def _attribute_name(self, alias, names):
        """STRICT by default: an alias the route did not declare is a KeyError."""
        return names[alias]

    def _assigned_value(self, source, item, names, values):
        """STRICT by default: only a declared `:alias` may be assigned."""
        del item, names
        return values[source]

    # -- writes ------------------------------------------------------------
    def update_item(self, **kwargs):
        self.update_item_calls.append(kwargs)
        key = (kwargs['Key']['pk'], kwargs['Key']['sk'])
        condition = kwargs.get('ConditionExpression')
        if condition and not self._holds(
            condition, self.items.get(key),
            kwargs.get('ExpressionAttributeNames', {}),
            kwargs.get('ExpressionAttributeValues', {}),
        ):
            raise conditional_check_failed('UpdateItem')
        stored = self._apply_update(key, kwargs)
        if kwargs.get('ReturnValues') == 'ALL_NEW' and stored is not None:
            return {'Attributes': stored}
        return {}

    def _apply_update(self, key, kwargs) -> dict | None:
        """The `SET` / `ADD` clauses, condition already checked.

        Returns the stored item; a subclass handling a clause that stores nothing
        to hand back (`REMOVE`) returns None.
        """
        expression = kwargs['UpdateExpression'].strip()
        names = kwargs.get('ExpressionAttributeNames', {})
        values = kwargs.get('ExpressionAttributeValues', {})
        item = self.items.setdefault(key, {'pk': key[0], 'sk': key[1]})
        # One expression may carry both clauses: the row half of a ballot
        # transaction is `SET #frozen_at = if_not_exists(...) ADD #ballot_writes :one`.
        set_clause, add_clause = expression, ''
        if ' ADD ' in expression:
            set_clause, _, add_clause = expression.partition(' ADD ')
        elif expression.upper().startswith('ADD'):
            set_clause, add_clause = '', expression[len('ADD'):]
        if set_clause:
            if not set_clause.strip().upper().startswith('SET'):
                raise AssertionError(expression)
            for assignment in split_top_level(set_clause.strip()[len('SET'):]):
                self._assign(item, assignment, names, values)
        if add_clause:
            name_alias, value_alias = add_clause.split()
            attribute = self._attribute_name(name_alias, names)
            item[attribute] = (item.get(attribute) or 0) + values[value_alias]
        return dict(item)

    def _assign(self, item, assignment, names, values):
        name_alias, _, source = (part.strip() for part in assignment.partition('='))
        attribute = self._attribute_name(name_alias, names)
        if source.startswith('if_not_exists('):
            existing_alias, fallback_alias = split_top_level(source[len('if_not_exists('):-1])
            # `if_not_exists` is what makes the freeze mark record the FIRST ballot
            # rather than the latest, so it is honoured rather than treated as a
            # plain assignment: a fake that overwrote would let an assignment pass
            # as a freeze instant.
            if self._attribute_name(existing_alias, names) not in item:
                item[attribute] = values[fallback_alias]
            return
        item[attribute] = self._assigned_value(source, item, names, values)

    def _transact_write_items(self, TransactItems):
        """All-or-nothing, which is the property every caller of this depends on.

        The capitalised parameter is boto3's own spelling of it, kept so the fake
        accepts exactly the call the route makes.

        Every condition is evaluated BEFORE any item is applied, and a single
        failure cancels the whole transaction with nothing written.

        `CancellationReasons` is ONE ENTRY PER ITEM, POSITIONALLY, with `'None'` for
        the items that did not fail — DynamoDB's own shape, verified against moto.
        Both routes read the reason at a specific item's index (to tell a vanished
        row from a write conflict), so a single-element list would let them pass
        here while reading the wrong position in production.
        """
        self.transact_calls.append(TransactItems)
        reasons = []
        for entry in TransactItems:
            (operation, request), = entry.items()
            # Raised explicitly rather than with `assert`: this is a support module,
            # so pytest does not rewrite its asserts and `-O` would strip them.
            if operation not in self.TRANSACT_OPERATIONS:
                raise AssertionError(operation)
            if request['TableName'] != self.name:
                raise AssertionError(request['TableName'])
            key = (request['Key']['pk'], request['Key']['sk'])
            holds = self._holds(
                request['ConditionExpression'], self.items.get(key),
                request.get('ExpressionAttributeNames', {}),
                request.get('ExpressionAttributeValues', {}),
            ) if request.get('ConditionExpression') else True
            reasons.append({'Code': 'None'} if holds else {
                'Code': 'ConditionalCheckFailed',
                'Message': 'The conditional request failed',
            })
        if any(reason['Code'] != 'None' for reason in reasons):
            raise cancelled_transaction(reasons)
        for entry in TransactItems:
            (operation, request), = entry.items()
            key = (request['Key']['pk'], request['Key']['sk'])
            if operation == 'Update':
                self._apply_update(key, request)
            elif operation == 'Delete':
                self.items.pop(key, None)
        return {}
