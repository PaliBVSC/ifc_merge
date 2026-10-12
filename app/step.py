"""Low-level helpers for ISO 10303-21 (STEP physical file) text.

Everything here works on raw bytes so it can run over memory-mapped files
without decoding gigabytes of text.
"""
from __future__ import annotations

import re
import uuid

# A STEP string literal: '...' where a quote is escaped by doubling it.
# Possessive quantifiers (*+, Python 3.11+) matter: without them the regex
# engine keeps backtracking state per character, which costs gigabytes on the
# multi-MB statements large models contain (e.g. a containment list of 1M refs).
STRING = rb"'(?:[^']++|'')*+'"

# Everything up to the ';' that ends a statement, skipping over strings.
ARGS = rb"(?:" + STRING + rb"|[^;']++)*+"

# One full entity instance: #id = TYPE ( args ) ;
# Group 3 runs up to the ';' and so still holds the closing ')': use entity_args().
ENTITY_RE = re.compile(rb"#(\d+)\s*=\s*([A-Z][A-Z0-9_]*)\s*\((" + ARGS + rb");")


def entity_args(m) -> bytes:
    """The argument list of an ENTITY_RE match, without the closing parenthesis."""
    a = m.group(3).rstrip()
    return a[:-1] if a.endswith(b")") else a

REF_RE = re.compile(rb"#(\d+)")
FLOAT_RE = re.compile(rb"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def split_args(args: bytes) -> list[bytes]:
    """Split the top level of a STEP argument list into its attributes."""
    out: list[bytes] = []
    depth = 0
    in_str = False
    start = 0
    i = 0
    n = len(args)
    while i < n:
        c = args[i]
        if in_str:
            if c == 0x27:  # '
                if i + 1 < n and args[i + 1] == 0x27:
                    i += 1
                else:
                    in_str = False
        elif c == 0x27:
            in_str = True
        elif c == 0x28:  # (
            depth += 1
        elif c == 0x29:  # )
            depth -= 1
        elif c == 0x2C and depth == 0:  # ,
            out.append(args[start:i].strip())
            start = i + 1
        i += 1
    tail = args[start:].strip()
    if tail or out:
        out.append(tail)
    return out


def ref(attr: bytes) -> int | None:
    """'#12' -> 12, '$' / '*' -> None."""
    attr = attr.strip()
    if attr.startswith(b"#"):
        return int(attr[1:])
    return None


def ref_list(attr: bytes) -> list[int]:
    return [int(x) for x in REF_RE.findall(attr)]


def floats(attr: bytes) -> list[float]:
    return [float(x) for x in FLOAT_RE.findall(attr)]


def string(attr: bytes) -> str | None:
    """Decode a STEP string attribute (including \\X2\\ / \\X\\ escapes)."""
    attr = attr.strip()
    if not attr.startswith(b"'"):
        return None
    return decode_string(attr[1:-1].replace(b"''", b"'"))


def enum(attr: bytes) -> str | None:
    attr = attr.strip()
    if attr.startswith(b".") and attr.endswith(b"."):
        return attr[1:-1].decode("ascii", "replace")
    return None


_X2_RE = re.compile(rb"\\X2\\([0-9A-Fa-f]*)\\X0\\")
_X4_RE = re.compile(rb"\\X4\\([0-9A-Fa-f]*)\\X0\\")
_X_RE = re.compile(rb"\\X\\([0-9A-Fa-f]{2})")


def decode_string(raw: bytes) -> str:
    def x2(m):
        h = m.group(1).decode()
        return "".join(chr(int(h[i:i + 4], 16)) for i in range(0, len(h), 4)).encode("utf-8")

    def x4(m):
        h = m.group(1).decode()
        return "".join(chr(int(h[i:i + 8], 16)) for i in range(0, len(h), 8)).encode("utf-8")

    raw = _X2_RE.sub(x2, raw)
    raw = _X4_RE.sub(x4, raw)
    raw = _X_RE.sub(lambda m: bytes([int(m.group(1), 16)]).decode("latin-1").encode("utf-8"), raw)
    raw = raw.replace(b"\\\\", b"\\")
    return raw.decode("utf-8", "replace")


def encode_string(s: str) -> bytes:
    """Encode text as a STEP string literal, escaping non-ASCII as \\X2\\."""
    out = []
    for ch in s:
        o = ord(ch)
        if ch == "'":
            out.append("''")
        elif ch == "\\":
            out.append("\\\\")
        elif 32 <= o < 127:
            out.append(ch)
        elif o <= 0xFFFF:
            out.append("\\X2\\%04X\\X0\\" % o)
        else:
            out.append("\\X4\\%08X\\X0\\" % o)
    return ("'" + "".join(out) + "'").encode("ascii")


def find_statement_end(buf: bytes, start: int) -> int:
    """Index just past the ';' that terminates the statement starting at `start`."""
    in_str = False
    i = start
    n = len(buf)
    while i < n:
        c = buf[i]
        if in_str:
            if c == 0x27:
                if i + 1 < n and buf[i + 1] == 0x27:
                    i += 1
                else:
                    in_str = False
        elif c == 0x27:
            in_str = True
        elif c == 0x3B:  # ;
            return i + 1
        i += 1
    return -1


_GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"


def new_guid() -> bytes:
    """A fresh IFC GlobalId (22-char compressed base64 of a UUID4)."""
    n = uuid.uuid4().int
    chars = []
    for _ in range(22):
        chars.append(_GUID_CHARS[n & 63])
        n >>= 6
    return "".join(reversed(chars)).encode("ascii")
