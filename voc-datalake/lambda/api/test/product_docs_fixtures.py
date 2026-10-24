"""The stored product-doc record, as the product-context tests build it.

`test_product_context_injection.py` and `test_visual_brief.py` both seed the
projects table with product docs and read the prompt that comes out; one builder
here is what keeps the two from drifting on what a record looks like.
"""


def product_doc(doc_id: str, content_type: str, *, status: str = 'ready',
                key: str | None = 'set', created_at: str = '2026-08-13T10:00:00+00:00') -> dict:
    """A product-doc item as DynamoDB stores it. `key=None` leaves it unextracted."""
    ext = {'text/markdown': 'md', 'text/plain': 'txt', 'image/png': 'png',
           'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp'}[content_type]
    return {
        'doc_id': doc_id,
        'filename': f'{doc_id}.{ext}',
        'content_type': content_type,
        'size_bytes': 2048,
        'status': status,
        'error': None,
        'extracted_chars': 100,
        's3_extracted_key': (
            f'projects/proj-1/product_docs/extracted/{doc_id}.txt' if key else None
        ),
        'created_at': created_at,
    }
