"""A feedback form's `theme`, checked before it is stored (Well-Architected SEC11, finding FE-2).

The embeddable widget (`lambda/api/static/feedback-widget.js`) runs on the CUSTOMER's own page and
concatenates the theme colours into `style.cssText`. Stored unchecked, a colour such as
`red;position:fixed;inset:0;background:url(https://…)` would let any app user restyle (cover, beacon from)
the customer's page. So the theme is a closed object of hex colours and a pixel radius; the widget
re-checks the colours on its side for themes stored before this rule.
"""
from __future__ import annotations

import re
from typing import Any, Final

from shared.exceptions import ValidationError

COLOR_FIELDS: Final = ('primary_color', 'background_color', 'text_color')
RADIUS_FIELD: Final = 'border_radius'
#: `#rgb`, `#rrggbb` or `#rrggbbaa`: the shapes a colour picker produces. Mirrored by the widget's HEX_COLOR.
HEX_COLOR: Final = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\Z')
#: A pixel radius from 0px to 99px.
RADIUS: Final = re.compile(r'^\d{1,2}px\Z')


def validate_theme(body: dict[str, Any]) -> None:
    """400 unless an included `theme` is an object of hex colours and a pixel `border_radius` (all optional)."""
    if 'theme' not in body:
        return
    theme = body['theme']
    if not isinstance(theme, dict):
        raise ValidationError('theme must be an object')
    unknown = sorted(set(theme) - {*COLOR_FIELDS, RADIUS_FIELD})
    if unknown:
        raise ValidationError(f'theme has unknown fields: {", ".join(str(key)[:40] for key in unknown[:5])}')
    for field in COLOR_FIELDS:
        value = theme.get(field)
        if value is not None and not (isinstance(value, str) and HEX_COLOR.match(value)):
            raise ValidationError(f'theme.{field} must be a hex colour such as #8e48ff')
    radius = theme.get(RADIUS_FIELD)
    if radius is not None and not (isinstance(radius, str) and RADIUS.match(radius)):
        raise ValidationError(f'theme.{RADIUS_FIELD} must be a pixel value such as 8px')
