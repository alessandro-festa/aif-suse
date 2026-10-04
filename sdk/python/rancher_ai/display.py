"""Tables for the terminal and for notebooks."""

from __future__ import annotations

import html
import os
import re
import sys
from typing import Any

STATE_COLOUR = {"Ready": "32", "Running": "32", "Completed": "34", "Queued": "33", "Beta": "33", "Deploying": "33",
                "Pending": "33", "Failed": "31", "Degraded": "31"}


def _colour() -> bool:
    return sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def paint(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _colour() and code else text


class Table:
    """Rows of dicts with fixed columns. Prints aligned text; renders as an HTML table in Jupyter;
    .to_pandas() for a DataFrame."""

    def __init__(self, rows: list[dict], columns: list[str], state_column: str | None = None, first_bold: bool = True,
                 empty: str = "No resources found."):
        self.rows, self.columns, self.state_column, self.first_bold = rows, columns, state_column, first_bold
        self.empty = empty

    def __len__(self) -> int:
        return len(self.rows)

    def __iter__(self):
        return iter(self.rows)

    def __getitem__(self, i):
        return self.rows[i]

    def text(self) -> str:
        if not self.rows:
            return self.empty
        heads = [c.upper().replace("_", " ") for c in self.columns]
        cells = [[str(r.get(c, "") if r.get(c) is not None else "") for c in self.columns] for r in self.rows]
        widths = [max(len(h), *(len(row[i]) for row in cells)) for i, h in enumerate(heads)]
        lines = ["   ".join(h.ljust(w) for h, w in zip(heads, widths)).rstrip()]
        for row in cells:
            out = []
            for i, (v, w) in enumerate(zip(row, widths)):
                padded = v.ljust(w)
                if i == 0 and self.first_bold:
                    padded = paint(padded, "36")
                elif self.columns[i] == self.state_column:
                    padded = paint(padded, STATE_COLOUR.get(v, ""))
                out.append(padded)
            lines.append("   ".join(out).rstrip())
        return "\n".join(lines)

    __repr__ = text

    def _repr_html_(self) -> str:
        if not self.rows:
            return f"<p>{html.escape(self.empty)}</p>"
        badge = {"Ready": "#1a7f37", "Running": "#1a7f37", "Completed": "#0969da", "Beta": "#9a6700", "Queued": "#9a6700",
                 "Deploying": "#9a6700", "Pending": "#9a6700", "Failed": "#cf222e", "Degraded": "#cf222e"}
        head = "".join(f"<th style='text-align:left'>{html.escape(c)}</th>" for c in self.columns)
        body = []
        for r in self.rows:
            tds = []
            for c in self.columns:
                v = html.escape(str(r.get(c, "") if r.get(c) is not None else ""))
                if c == self.state_column and v in badge:
                    v = f"<span style='background:{badge[v]};color:#fff;border-radius:10px;padding:1px 8px'>{v}</span>"
                elif c == self.columns[0] and self.first_bold:
                    v = f"<span style='color:#0969da'>{v}</span>"
                tds.append(f"<td style='text-align:left'>{v}</td>")
            body.append("<tr>" + "".join(tds) + "</tr>")
        return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"

    def to_pandas(self) -> Any:
        return frame(self.rows, self.columns)


_Frame = None


def frame(rows: list[dict], columns: list[str]) -> Any:
    """A DataFrame that shows in Jupyter with full cell text (pandas cuts at 50 characters) and
    left-aligned, without changing pandas options for the rest of the notebook. Otherwise an ordinary
    DataFrame."""
    global _Frame
    import pandas as pd

    if _Frame is None:
        class ProfilesFrame(pd.DataFrame):
            @property
            def _constructor(self):
                return ProfilesFrame

            def _repr_html_(self):
                try:
                    with pd.option_context("display.max_colwidth", None):
                        return (self.style.hide(axis="index")
                                .set_properties(**{"text-align": "left", "vertical-align": "top"})
                                .set_table_styles([{"selector": "th", "props": [("text-align", "left")]}])
                                .to_html())
                except Exception:  # Styler needs jinja2; without it, the plain table, untruncated
                    with pd.option_context("display.max_colwidth", None):
                        return super()._repr_html_()

        _Frame = ProfilesFrame
    return _Frame(rows, columns=columns)


def kv(title: str, rows: list[tuple[str, Any]], ok: bool = True) -> str:
    w = max(len(k) for k, _ in rows) + 1
    mark = paint("✓", "32") if ok else paint("✗", "31")
    body = "\n".join(f"  {(k + ':').ljust(w)}  {v}" for k, v in rows)
    return f"{mark} {title}\n{body}"


_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_BREAK = re.compile(r"[\n\r\u2028\u2029]")


def plain(v) -> str:
    """Text for a terminal: a run reports its own result, so its text is untrusted. Control characters
    (escape sequences can move the cursor, recolour or overwrite lines, set a window title) become '?', and
    a line break becomes a space, so a value cannot start a line of its own that looks like another check."""
    return _CONTROL.sub("?", _BREAK.sub(" ", "" if v is None else str(v)))
