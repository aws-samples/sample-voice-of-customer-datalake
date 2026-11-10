"""Support for the MagicMock-table tests of `shared.feedback`'s sampled read.

Those doubles answer every query with whole items, while the real read queries a
projected pool and then fetches the sampled rows in full by table key. Making the
by-key fetch the identity lets them keep pinning the walk; the real BatchGetItem
fetch is covered on moto in test_feedback_sampling.py.
"""


def fetch_rows_as_read(monkeypatch) -> None:
    """Make `shared.feedback`'s by-key fetch return the pool rows unchanged."""
    monkeypatch.setattr('shared.feedback.fetch_full', lambda _table, rows: list(rows))
