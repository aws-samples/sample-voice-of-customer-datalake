"""An avatar object records which project owns it, because its key cannot.

`avatars/{persona_id}.{ext}` is the one key space a project owns that carries no
project component, and persona ids are not globally unique: `create_persona`
(`api/projects.py`) and the persona importer (`jobs/persona_importer/handler.py`)
both mint `persona_{YYYYMMDDHHMMSS}` with no project part and no randomness, so two
personas created in the same wall-clock second in DIFFERENT projects name one
object.

That made a project delete's avatar sweep — which has to work from an id list,
there being no prefix to sweep — able to remove a live avatar from a project nobody
deleted, leaving a surviving persona row pointing at a 404. Data loss outside the
deleted project, which no amount of retry-safety in the sweep excuses.

The owner is therefore recorded at WRITE time, the only moment it is known for
certain, and read back before any delete. This file pins the two halves of that
round trip and the collision they exist for; `api/test/test_project_delete_lifecycle_moto.py`
pins the sweep that consumes it.
"""
import base64
import json
from unittest.mock import MagicMock, patch

import pytest

from shared.avatar import (
    AVATAR_OWNER_METADATA_KEY,
    avatar_object_keys,
    avatar_object_owner,
)


def test_two_projects_can_mint_one_avatar_key():
    """The collision is real, not theoretical — the premise everything else rests on.

    Asserted against the id EXPRESSION the two writers share rather than by calling
    them (one is a route, one a job handler, and both do far more than mint an id).
    Two calls in the same wall-clock second are the reachable case; the second-
    resolution timestamp is reproduced from a fixed struct_time so this does not
    depend on winning a race with the clock.
    """
    import time

    # `persona_{YYYYMMDDHHMMSS}`, verbatim from `api/projects.py::create_persona`
    # and `jobs/persona_importer/handler.py`. No project component, no randomness.
    same_second = time.struct_time((2026, 1, 1, 12, 0, 0, 2, 1, 0))
    first = f"persona_{time.strftime('%Y%m%d%H%M%S', same_second)}"
    second = f"persona_{time.strftime('%Y%m%d%H%M%S', same_second)}"

    assert first == second
    # And therefore ONE object, which is the part that matters: two personas in two
    # different projects, one avatar key, and nothing in the key to tell them apart.
    assert avatar_object_keys(first) == avatar_object_keys(second)


class TestTheOwnerIsRecordedAtWriteTime:
    """The write is the only moment the owner is known; the key never carries it."""

    @staticmethod
    def _write(project_id):
        """Run one avatar generation and return the `put_object` kwargs."""
        s3 = MagicMock()
        bedrock_runtime = MagicMock()
        bedrock_runtime.invoke_model.return_value = {
            'body': MagicMock(read=MagicMock(return_value=json.dumps(
                {'images': [base64.b64encode(b'bytes').decode()]},
            ).encode())),
        }

        with patch('shared.aws.get_s3_client', return_value=s3), \
                patch('shared.avatar.get_image_model_client', return_value=bedrock_runtime), \
                patch('shared.avatar.generate_avatar_prompt_with_llm', return_value='p'):
            from shared.avatar import generate_persona_avatar
            result = generate_persona_avatar(
                {'persona_id': 'p123', 'name': 'Test'},
                MagicMock(),
                s3_bucket='test-bucket',
                project_id=project_id,
            )

        assert result['avatar_url'] == 's3://test-bucket/avatars/p123.jpeg'
        return s3.put_object.call_args.kwargs

    def test_the_project_is_stamped_on_the_object(self):
        arguments = self._write('proj-1')

        assert arguments['Metadata'] == {AVATAR_OWNER_METADATA_KEY: 'proj-1'}

    def test_no_owner_is_stamped_when_the_caller_has_no_project(self):
        """Omitted, not written empty.

        "Absent" and "owned by nobody" have to stay distinguishable, and the delete
        declines either way — but an empty string would read as a real owner value to
        any future consumer of this metadata.
        """
        arguments = self._write(None)

        assert 'Metadata' not in arguments

    def test_the_bytes_and_the_content_type_are_unchanged_by_the_stamp(self):
        """The stamp is additive. It rides along on the same `put_object` that writes
        the image, so it cannot be present on an object whose upload half-failed —
        but it must not have changed what that upload writes."""
        arguments = self._write('proj-1')

        assert arguments['Key'] == 'avatars/p123.jpeg'
        assert arguments['ContentType'] == 'image/jpeg'
        assert arguments['Body'] == b'bytes'
        assert arguments['CacheControl'] == 'public, max-age=31536000, immutable'


class TestTheOwnerIsReadBack:
    """`avatar_object_owner` answers the delete's question, or refuses to guess."""

    def test_it_returns_the_recorded_project(self):
        s3 = MagicMock()
        s3.head_object.return_value = {
            'Metadata': {AVATAR_OWNER_METADATA_KEY: 'proj-1'},
        }

        assert avatar_object_owner(s3, 'b', 'avatars/p.jpeg') == 'proj-1'
        s3.head_object.assert_called_once_with(Bucket='b', Key='avatars/p.jpeg')

    @pytest.mark.parametrize('response', [
        pytest.param({}, id='no metadata at all'),
        pytest.param({'Metadata': {}}, id='metadata with no owner'),
        pytest.param({'Metadata': {AVATAR_OWNER_METADATA_KEY: ''}}, id='an empty owner'),
        pytest.param({'Metadata': None}, id='a null metadata block'),
        pytest.param({'Metadata': 'not-a-dict'}, id='a non-mapping metadata block'),
        pytest.param(
            {'Metadata': {AVATAR_OWNER_METADATA_KEY: None}}, id='a null owner value',
        ),
    ])
    def test_an_object_that_names_no_owner_answers_none(self, response):
        """Every shape that is not a usable owner string, including the ones a
        `.get` chain would have raised on. This function's callers are deletes, so
        an exception here would abort a sweep whose durable work has committed."""
        s3 = MagicMock()
        s3.head_object.return_value = response

        assert avatar_object_owner(s3, 'b', 'avatars/p.jpeg') is None

    def test_an_absent_object_answers_none_rather_than_raising(self):
        from botocore.exceptions import ClientError

        s3 = MagicMock()
        s3.head_object.side_effect = ClientError(
            {'Error': {'Code': '404'}}, 'HeadObject',
        )

        assert avatar_object_owner(s3, 'b', 'avatars/p.jpeg') is None

    def test_a_failed_head_answers_none_rather_than_raising(self):
        """A connection failure is "cannot tell", not "not mine" — and above all not
        an exception, since the caller is mid-delete with rows already gone."""
        s3 = MagicMock()
        s3.head_object.side_effect = RuntimeError('endpoint unreachable')

        assert avatar_object_owner(s3, 'b', 'avatars/p.jpeg') is None


def test_the_write_and_the_read_agree_on_the_metadata_key():
    """The round trip, with no shared literal between the two halves.

    S3 lowercases and prefixes user metadata on the wire and boto3 strips the prefix
    back off; the writer and the reader would silently disagree if either spelled the
    key itself. Asserted here against a real S3 (moto) rather than a MagicMock,
    because a mock would return whatever key the test put in and prove nothing about
    that transformation.
    """
    import boto3
    from moto import mock_aws

    with mock_aws():
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket='test-avatar-bucket')
        s3.put_object(
            Bucket='test-avatar-bucket',
            Key='avatars/p.jpeg',
            Body=b'x',
            Metadata={AVATAR_OWNER_METADATA_KEY: 'proj-1'},
        )

        assert avatar_object_owner(s3, 'test-avatar-bucket', 'avatars/p.jpeg') == 'proj-1'
