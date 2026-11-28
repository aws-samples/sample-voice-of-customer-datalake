"""The describe / it / test blocks of a vitest or Playwright file, from its tokens (no JavaScript is run).

A token pass that knows strings, template literals, comments and regex literals, so a brace or a quote inside them
never counts; then every call ``describe|it|test|suite[.<modifier>…](<string literal>, …)`` is a block, nested by
its parentheses. ``it.each(table)('title', fn)`` and ``describe.skipIf(cond)('title', fn)`` take their title from
the second call. A title written as a template literal with ``${…}`` cannot be named and is no block anyone can
register. ``test.skip()`` / ``test.fixme()`` with no title inside a block skips it, and so does one whose condition
is a literal that always holds (``true``, ``!0``, ``!false``); any other condition is a conditional skip. JSX text with a lone quote or ``/`` may hide a title on its line: such a test is reported as not
found, never wrongly found.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

BASES = {'describe', 'it', 'test', 'suite'}
MODIFIERS = {'skip', 'only', 'todo', 'fixme', 'concurrent', 'sequential', 'serial', 'parallel', 'each', 'for',
             'skipIf', 'runIf', 'fail', 'describe', 'shuffle'}
SKIPPING = ('skip', 'skipIf', 'runIf', 'todo', 'fixme', 'fail')
PRE_CALL = {'each', 'for', 'skipIf', 'runIf'}   # a call that comes before the title's call
# The conditions of a test.skip(…) / test.fixme(…) that always hold: none, `true`, `!0`, `!false`.
ALWAYS = ([], [('id', 'true')], [('punct', '!'), ('other', '0')], [('punct', '!'), ('id', 'false')])
KEYWORDS = {'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'}
IDENT_RE = re.compile(r'[A-Za-z_$][\w$]*')
NUMBER_RE = re.compile(r'\d[\w.]*')
ESCAPES = {'n': '\n', 't': '\t', 'r': '\r', '0': '\0'}
SEP = ' > '


@dataclass(frozen=True)
class Token:
    kind: str           # id | str | tpl (a template with ${…}) | punct | other (number, regex)
    value: str | None
    start: int
    end: int


@dataclass
class Block:
    kind: str           # describe | test
    title: str | None   # None: a template title with ${…}
    mods: list[str]
    start: int
    end: int
    parent: Block | None = None
    own_skip: bool = False
    own_conditional_skip: bool = False

    def chain(self) -> list[Block]:
        out: list[Block] = []
        node: Block | None = self
        while node is not None:
            out.insert(0, node)
            node = node.parent
        return out

    @property
    def path(self) -> str | None:
        titles = [b.title for b in self.chain()]
        return None if any(t is None for t in titles) else SEP.join(t for t in titles if t is not None)

    @property
    def skipped_by(self) -> list[str]:
        out = []
        for b in self.chain():
            out += [f'marked .{m}' if b is self else f'inside {b.kind}.{m} {b.title!r}' for m in b.mods if m in SKIPPING]
        return out

    @property
    def self_skip(self) -> bool:
        return any(b.own_skip for b in self.chain())

    @property
    def conditional_skip(self) -> bool:
        return any(b.own_conditional_skip for b in self.chain())


@dataclass
class Scan:
    blocks: list[Block] = field(default_factory=list)
    has_only: bool = False
    file_skip: str | None = None   # 'always' / 'conditional': a test.skip(…) outside every block


def _quoted(src: str, i: int) -> tuple[int, str | None]:
    """The string or template literal at ``i``: its end and its value (None for a template with ``${…}`` or an
    unterminated one). A quoted string ends at its line's end at the latest; a template may span lines."""
    quote = src[i]
    buf: list[str] = []
    literal = True
    j = i + 1
    while j < len(src):
        ch = src[j]
        if ch == '\\' and j + 1 < len(src):
            buf.append(ESCAPES.get(src[j + 1], src[j + 1]))
            j += 2
        elif ch == quote:
            return j + 1, ''.join(buf) if literal else None
        elif ch == '\n' and quote != '`':
            return j, ''.join(buf)
        elif quote == '`' and src.startswith('${', j):
            literal = False
            j = _skip_expression(src, j + 2)
        else:
            buf.append(ch)
            j += 1
    return j, ''.join(buf) if quote != '`' else None


def _skip_expression(src: str, j: int) -> int:
    depth = 1
    while j < len(src) and depth:
        ch = src[j]
        if ch in '\'"`':
            j = _quoted(src, j)[0]
            continue
        depth += {'{': 1, '}': -1}.get(ch, 0)
        j += 1
    return j


def _regex_allowed(tokens: list[Token]) -> bool:
    if not tokens:
        return True
    last = tokens[-1]
    if last.kind == 'punct':
        return last.value not in (')', ']')
    return last.kind == 'id' and last.value in KEYWORDS


def _regex(src: str, i: int) -> int | None:
    """The end of the regex literal at ``i``; None when it is none (JSX's ``</`` and ``/>``, or no closing ``/`` on
    its line), so the ``/`` is read as punctuation."""
    if src[i - 1:i] == '<' or src.startswith('/>', i):
        return None
    j = i + 1
    in_class = False
    while j < len(src) and src[j] != '\n':
        ch = src[j]
        if ch == '\\':
            j += 2
            continue
        if ch == '/' and not in_class:
            j += 1
            while j < len(src) and src[j].isalpha():
                j += 1
            return j
        in_class = (in_class or ch == '[') and ch != ']'
        j += 1
    return None


def _token_at(src: str, i: int, tokens: list[Token]) -> tuple[Token | None, int]:
    """The token starting at ``i`` (None for a comment) and where the next one may start."""
    ch = src[i]
    if src.startswith('//', i):
        end = src.find('\n', i)
        return None, len(src) if end < 0 else end
    if src.startswith('/*', i):
        end = src.find('*/', i + 2)
        return None, len(src) if end < 0 else end + 2
    if ch in '\'"`':
        end, text = _quoted(src, i)
        return Token('str' if text is not None else 'tpl', text, i, end), end
    if ch == '/' and _regex_allowed(tokens) and (end := _regex(src, i)) is not None:
        return Token('other', None, i, end), end
    for kind, pattern in (('id', IDENT_RE), ('other', NUMBER_RE)):
        if m := pattern.match(src, i):
            return Token(kind, m.group(), i, m.end()), m.end()
    return Token('punct', ch, i, i + 1), i + 1


def tokenize(src: str) -> list[Token]:
    tokens: list[Token] = []
    i = 0
    while i < len(src):
        if src[i].isspace():
            i += 1
            continue
        token, i = _token_at(src, i, tokens)
        if token is not None:
            tokens.append(token)
    return tokens


def _closers(tokens: list[Token]) -> dict[int, int]:
    """Index of each ``(`` -> index of its ``)``."""
    out: dict[int, int] = {}
    stack: list[int] = []
    for k, tok in enumerate(tokens):
        if tok.kind != 'punct':
            continue
        if tok.value in ('(', '[', '{'):
            stack.append(k)
        elif tok.value in (')', ']', '}') and stack:
            opened = stack.pop()
            if tok.value == ')' and tokens[opened].value == '(':
                out[opened] = k
    return out


def _is(tokens: list[Token], k: int, value: str) -> bool:
    return k < len(tokens) and tokens[k].kind == 'punct' and tokens[k].value == value


def _chain(tokens: list[Token], k: int) -> tuple[list[str], int]:
    names = [str(tokens[k].value)]
    j = k + 1
    while _is(tokens, j, '.') and j + 1 < len(tokens) and tokens[j + 1].kind == 'id':
        names.append(str(tokens[j + 1].value))
        j += 2
    return names, j


@dataclass(frozen=True)
class _Call:
    names: list[str]
    open: int       # the title call's (
    close: int      # its )


def literal_values(tokens: list[Token], k: int) -> list[str]:
    """The string literals of ``: 'a'`` or ``: ['a', 'b']`` starting at token ``k`` (the colon)."""
    if not _is(tokens, k, ':'):
        return []
    if k + 1 < len(tokens) and tokens[k + 1].kind == 'str':
        return [str(tokens[k + 1].value)]
    out: list[str] = []
    if _is(tokens, k + 1, '['):
        for tok in tokens[k + 2:]:
            if tok.kind == 'punct' and tok.value == ']':
                break
            if tok.kind == 'str':
                out.append(str(tok.value))
    return out


def _aliases(tokens: list[Token]) -> dict[str, list[str]]:
    """``const later = describe.skip`` (not called): ``later`` names that chain."""
    out: dict[str, list[str]] = {}
    for k in range(len(tokens) - 3):
        if (tokens[k].kind == 'id' and tokens[k].value in ('const', 'let', 'var') and tokens[k + 1].kind == 'id'
                and _is(tokens, k + 2, '=') and tokens[k + 3].kind == 'id' and tokens[k + 3].value in BASES):
            names, j = _chain(tokens, k + 3)
            if not _is(tokens, j, '(') and all(m in MODIFIERS for m in names[1:]):
                out[str(tokens[k + 1].value)] = names
    return out


def _call_at(tokens: list[Token], k: int, closers: dict[int, int],
             aliases: dict[str, list[str]] | None = None) -> _Call | None:
    tok = tokens[k]
    aliases = aliases or {}
    if tok.kind != 'id' or (tok.value not in BASES and tok.value not in aliases) or (k and _is(tokens, k - 1, '.')):
        return None
    names, j = _chain(tokens, k)
    if names[0] in aliases:
        names = aliases[names[0]] + names[1:]
    if any(m not in MODIFIERS for m in names[1:]) or not _is(tokens, j, '('):
        return None
    if names[-1] in PRE_CALL and j in closers:
        j = closers[j] + 1
        if not _is(tokens, j, '('):
            return None
    if j not in closers:
        return None
    return _Call(names, j, closers[j])


def _runtime_skip(call: _Call, tokens: list[Token]) -> str | None:
    """'always' / 'conditional' for a test.skip(…) / test.fixme(…) call with no title, else None."""
    if call.names[0] != 'test' or call.names[1:] not in (['skip'], ['fixme']):
        return None
    first = tokens[call.open + 1]
    if first.kind in ('str', 'tpl'):
        return None
    args = tokens[call.open + 1:call.close]
    condition = args[:next((k for k, t in enumerate(args) if t.kind == 'punct' and t.value == ','), len(args))]
    return 'always' if [(t.kind, t.value) for t in condition] in ALWAYS else 'conditional'


def _innermost(blocks: list[Block], start: int, end: int) -> Block | None:
    inside = [b for b in blocks if b.start <= start and end <= b.end and (b.start, b.end) != (start, end)]
    return max(inside, key=lambda b: b.start) if inside else None


OPTION_MODS = {'skip': 'skip', 'todo': 'todo', 'fails': 'fail', 'only': 'only'}


def _option_mods(call: _Call, tokens: list[Token]) -> list[str]:
    """``it('t', { skip: true }, fn)``: the options object after the title, its flags set to a literal true."""
    k = call.open + 2
    if not (_is(tokens, k, ',') and _is(tokens, k + 1, '{')):
        return []
    out, depth = [], 0
    for j in range(k + 1, call.close):
        tok = tokens[j]
        if tok.kind == 'punct' and tok.value in ('{', '}'):
            depth += 1 if tok.value == '{' else -1
            if depth == 0:
                break
        elif (depth == 1 and tok.kind == 'id' and tok.value in OPTION_MODS and _is(tokens, j + 1, ':')
              and j + 2 < len(tokens) and (tokens[j + 2].kind, tokens[j + 2].value) == ('id', 'true')):
            out.append(OPTION_MODS[str(tok.value)])
    return out


def _block(call: _Call, tokens: list[Token], start: int) -> Block:
    first = tokens[call.open + 1]
    is_describe = call.names[0] in ('describe', 'suite') or 'describe' in call.names[1:]
    title = first.value if first.kind == 'str' else None
    mods = call.names[1:] + _option_mods(call, tokens)
    return Block('describe' if is_describe else 'test', title, mods, start, tokens[call.close].end)


def _context_skips(tokens: list[Token]) -> list[tuple[int, int, str]]:
    """``ctx.skip()`` / ``skip()`` with no arguments (vitest's test context): it skips the test it runs in."""
    out = []
    for k in range(len(tokens) - 2):
        tok = tokens[k]
        if tok.kind != 'id' or tok.value != 'skip' or not (_is(tokens, k + 1, '(') and _is(tokens, k + 2, ')')):
            continue
        callee = tokens[k - 2] if k >= 2 and _is(tokens, k - 1, '.') else None
        if callee is None or (callee.kind == 'id' and callee.value not in BASES):
            out.append((tok.start, tokens[k + 2].end, 'always'))
    return out


def scan(src: str) -> Scan:
    tokens = tokenize(src)
    closers = _closers(tokens)
    aliases = _aliases(tokens)
    out = Scan()
    skips: list[tuple[int, int, str]] = _context_skips(tokens)
    for k in range(len(tokens)):
        call = _call_at(tokens, k, closers, aliases)
        if call is None:
            continue
        out.has_only = out.has_only or 'only' in call.names[1:] or 'only' in _option_mods(call, tokens)
        how = _runtime_skip(call, tokens)
        if how:
            skips.append((tokens[k].start, tokens[call.close].end, how))
        elif tokens[call.open + 1].kind in ('str', 'tpl'):
            out.blocks.append(_block(call, tokens, tokens[k].start))
    for b in out.blocks:
        b.parent = _innermost(out.blocks, b.start, b.end)
    for start, end, how in skips:
        owner = _innermost(out.blocks, start, end)
        if owner is None:
            out.file_skip = 'always' if how == 'always' or out.file_skip == 'always' else 'conditional'
        elif how == 'always':
            owner.own_skip = True
        else:
            owner.own_conditional_skip = True
    return out
