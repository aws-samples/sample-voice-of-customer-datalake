"""The build-prototype call both source-selection test modules make.

`test_build_prototype_sources.py` (research reports and prototypes) and
`test_visual_selection_boundary.py` (product docs) each seed a projects table with
their own documents and then drive `POST /projects/<id>/build-prototype` the same
way: reads answered on the WHOLE composite key, the job creation and the
generator invocation patched. The seeding stays in each module, because which
documents exist is the whole question there; the call lives here.
"""
from unittest.mock import patch

from handler_events_fixtures import project_meta_table


def build_prototype_against(documents, body, api_gateway_event, lambda_context, *, project_id, path):
    """Run the route against a table holding exactly `documents` (keyed `(pk, sk)`).

    Reads are answered on the whole composite key rather than on `sk` alone. That
    is what makes "a document belonging to another project" a distinct fixture from
    "no such document": keyed on `sk` only, the two would be the same table and a
    test could not tell a dropped partition key apart from a working one.

    Returns `(response, job_config, table, invoke, create_job)`, where `job_config`
    is the doc_config handed to the generator, or None when no job was created.
    """
    table = project_meta_table(project_id)
    # The project's META comes from `project_meta_table`: every job-starting route
    # now confirms the project exists before it writes a JOB row, and which
    # DOCUMENTS exist is the only question these modules ask. Documents are
    # answered first, on the same whole `(pk, sk)` key, and every other read falls
    # through to the META double.
    read_meta = table.get_item.side_effect

    def get_item(Key=None, **kwargs):
        key = Key or {}
        document = documents.get((key.get('pk', ''), key.get('sk', '')))
        if document:
            return {'Item': document}
        return read_meta(Key=Key, **kwargs)

    table.get_item.side_effect = get_item

    with patch('projects_handler.get_projects_table', return_value=table), \
            patch('projects_handler.create_job', return_value=('job_1', {})) as create_job, \
            patch('projects_handler.invoke_lambda_async') as invoke:
        from projects_handler import lambda_handler
        response = lambda_handler(
            api_gateway_event(method='POST', path=path, body=body, path_params={'project_id': project_id}),
            lambda_context,
        )
    config = create_job.call_args.args[3] if create_job.call_args else None
    return response, config, table, invoke, create_job
