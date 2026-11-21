"""The dates of an imported file (the import wizard, docs/import-wizard.md): one column's values read as ISO 8601.

Another tool's export writes its dates its own way: ISO 8601 (``2026-03-14``, ``2026-03-14T09:30:00Z``), a day-first
or month-first date with ``/``, ``.`` or ``-`` (``14/03/2026``, ``03/14/2026 9:30``, ``14.03.26``), or an Excel serial
number (``46095``, ``46095.4``: days since 1899-12-30, which is how a spreadsheet's date cell reads once exported as
a number). ``date_order`` (``dmy``, ``mdy`` or ``ymd``) settles the slashed forms: ``infer_date_order`` reads it off a
column's values (a first part above 12 is a day, a second part above 12 is a day), and the wizard lets a person
change it. ``normalise_date`` answers ``YYYY-MM-DDTHH:MM:SS+00:00`` (a time zone the value names is converted to UTC;
a value without one is read as UTC) or None for a value that is not a date, so a row is refused rather than queued
with a date the processor would reject.

Pure: no I/O, no clock.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Final

__all__ = ['DATE_ORDERS', 'infer_date_order', 'is_excel_serial', 'looks_like_date', 'normalise_date']

DATE_ORDERS: Final = ('dmy', 'mdy', 'ymd')
DEFAULT_DATE_ORDER: Final = 'dmy'
#: Excel's day zero (its 1900 leap-year bug folded in: serial 60 is the phantom 29 February, never a real export).
_EXCEL_EPOCH: Final = datetime(1899, 12, 30, tzinfo=UTC)
#: The serials read as dates: 1954-10-03 to 2119-01-06. A number outside is a count or an id, not a date.
EXCEL_SERIAL_RANGE: Final = (20_000, 80_000)
_SERIAL: Final = re.compile(r'(\d{5})(?:[.,](\d{1,12}))?')
_PARTS: Final = re.compile(
    r'(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})'
    r'(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?\s*([AaPp][Mm])?)?')
_MIN_YEAR: Final = 1900
_MAX_YEAR: Final = 2200
_TWO_DIGIT_PIVOT: Final = 70
_MONTHS: Final = 12
_HALF_DAY: Final = 12


def is_excel_serial(value: str) -> bool:
    """A five-digit day number (an optional fraction is the time of day) in ``EXCEL_SERIAL_RANGE``."""
    match = _SERIAL.fullmatch(value.strip())
    return bool(match) and EXCEL_SERIAL_RANGE[0] <= int(match.group(1)) <= EXCEL_SERIAL_RANGE[1]


def _from_serial(value: str) -> datetime | None:
    match = _SERIAL.fullmatch(value.strip())
    if not match or not EXCEL_SERIAL_RANGE[0] <= int(match.group(1)) <= EXCEL_SERIAL_RANGE[1]:
        return None
    fraction = float(f'0.{match.group(2)}') if match.group(2) else 0.0
    return _EXCEL_EPOCH + timedelta(days=int(match.group(1)), seconds=round(fraction * 86_400))


def _from_iso(value: str) -> datetime | None:
    text = value.strip().replace('Z', '+00:00').replace('z', '+00:00')
    if not re.match(r'\d{4}-\d{2}-\d{2}', text):
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


def _year(raw: str) -> int:
    year = int(raw)
    if len(raw) <= 2:
        return 2000 + year if year < _TWO_DIGIT_PIVOT else 1900 + year
    return year


def _ordered(first: str, second: str, third: str, order: str) -> tuple[int, int, int] | None:
    """``(year, month, day)`` of the three parts in ``order`` (a four-digit first part is always a year)."""
    if len(first) == 4 or order == 'ymd':
        return _year(first), int(second), int(third)
    if len(third) not in (2, 4):
        return None
    if order == 'mdy':
        return _year(third), int(first), int(second)
    return _year(third), int(second), int(first)


def _clock(hour: str | None, minute: str | None, second: str | None, meridiem: str | None) -> tuple[int, int, int]:
    if hour is None or minute is None:
        return 0, 0, 0
    hours = int(hour)
    if meridiem:
        hours = hours % _HALF_DAY + (_HALF_DAY if meridiem.lower() == 'pm' else 0)
    return hours, int(minute), int(second or 0)


def _from_parts(value: str, order: str) -> datetime | None:
    match = _PARTS.fullmatch(value.strip())
    if not match:
        return None
    first, second, third, hour, minute, sec, meridiem = match.groups()
    ymd = _ordered(first, second, third, order)
    if ymd is None:
        return None
    year, month, day = ymd
    if not _MIN_YEAR <= year <= _MAX_YEAR:
        return None
    try:
        return datetime(year, month, day, *_clock(hour, minute, sec, meridiem), tzinfo=UTC)
    except ValueError:
        return None


def normalise_date(value: object, date_order: str = DEFAULT_DATE_ORDER) -> str | None:
    """``value`` as ``YYYY-MM-DDTHH:MM:SS+00:00`` (UTC), or None when it is no date ``date_order`` can read."""
    if not isinstance(value, str) or not value.strip():
        return None
    order = date_order if date_order in DATE_ORDERS else DEFAULT_DATE_ORDER
    parsed = _from_iso(value) or _from_serial(value) or _from_parts(value, order)
    if parsed is None or not _MIN_YEAR <= parsed.year <= _MAX_YEAR:
        return None
    return parsed.replace(microsecond=0).isoformat()


def looks_like_date(value: str) -> bool:
    """Whether ``value`` reads as a date in some order (detection: the order is decided for the whole column)."""
    return any(normalise_date(value, order) is not None for order in DATE_ORDERS)


def infer_date_order(values: Iterable[str]) -> str:
    """The order of a column's slashed dates: ``mdy`` when a second part goes above 12 (and no first part does),
    ``ymd`` when the dates start with a four-digit year, else ``dmy`` (a first part above 12 confirms it; a column
    where every part is 12 or less is ambiguous and stays day-first, which the wizard shows and lets a person change)."""
    day_first = month_first = year_first = False
    for value in values:
        match = _PARTS.fullmatch(value.strip())
        if not match:
            continue
        first, second = match.group(1), match.group(2)
        if len(first) == 4:
            year_first = True
        elif int(first) > _MONTHS:
            day_first = True
        elif int(second) > _MONTHS:
            month_first = True
    if month_first and not day_first:
        return 'mdy'
    if year_first and not (day_first or month_first):
        return 'ymd'
    return DEFAULT_DATE_ORDER
