"""Builders for the job tests that need the projects and feedback tables to be
DIFFERENT doubles (the `mock_dynamodb` fixture hands out one table for every
name), so a test can assert which table a handler queried."""
from unittest.mock import MagicMock


def route_tables(mock_dynamodb, *, projects_table, feedback_table) -> None:
    """Make the resource's ``Table(name)`` factory return *feedback_table* for the
    feedback table name and *projects_table* for every other name."""
    def table_factory(name):
        if 'feedback' in name.lower():
            return feedback_table
        return projects_table

    mock_dynamodb['resource'].Table.side_effect = table_factory


def project_and_feedback_tables(
    mock_dynamodb, *, project_items=(), feedback_items=(), transact_write_items=None,
):
    """Route the resource to a fresh projects table answering *project_items* and
    a fresh feedback table answering *feedback_items*; returns both doubles.

    ``transact_write_items`` is the side effect the projects table's transaction
    client should run; by default a transaction simply succeeds.
    """
    projects_table = MagicMock()
    projects_table.name = 'test-projects-table'
    projects_table.get_item.return_value = {}
    if transact_write_items is None:
        projects_table.meta.client.transact_write_items.return_value = {}
    else:
        projects_table.meta.client.transact_write_items.side_effect = transact_write_items
    projects_table.query.return_value = {'Items': list(project_items)}
    projects_table.put_item.return_value = {}
    projects_table.update_item.return_value = {}

    feedback_table = MagicMock()
    feedback_table.query.return_value = {'Items': list(feedback_items)}

    route_tables(mock_dynamodb, projects_table=projects_table, feedback_table=feedback_table)
    return projects_table, feedback_table


def feedback_table_beside(mock_dynamodb, feedback_items=()) -> MagicMock:
    """A fresh feedback table answering *feedback_items*, routed beside the
    shared ``mock_dynamodb['table']``, which keeps serving as the projects table."""
    feedback_table = MagicMock()
    feedback_table.query.return_value = {'Items': list(feedback_items)}
    route_tables(mock_dynamodb, projects_table=mock_dynamodb['table'], feedback_table=feedback_table)
    return feedback_table


def negative_webscraper_reviews(count: int) -> list[dict]:
    """*count* negative webscraper feedback rows, `review 0` … `review n-1`."""
    return [
        {'original_text': f'review {i}', 'source_platform': 'webscraper', 'sentiment_label': 'negative'}
        for i in range(count)
    ]
