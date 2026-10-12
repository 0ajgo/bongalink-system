"""Run a .sql file (mysqldump output or a migration with DELIMITER blocks) through
PyMySQL, the way the mysql command-line client would. Used by import_sales.py and
the integration tests so they need no mysql client installed."""
from __future__ import annotations

from pathlib import Path


def statements(sql: str) -> list[str]:
    out, buf, delim = [], [], ";"
    for line in sql.splitlines():
        stripped = line.strip()
        if not buf and (not stripped or stripped.startswith("--")):
            continue
        if stripped.upper().startswith("DELIMITER "):
            delim = stripped.split(None, 1)[1]
            continue
        if stripped.endswith(delim):
            buf.append(line.rstrip()[: -len(delim)])
            stmt = "\n".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(line)
    if "\n".join(buf).strip():
        out.append("\n".join(buf).strip())
    return out


def run_file(conn, path: Path) -> int:
    stmts = statements(Path(path).read_text(encoding="utf-8-sig"))
    with conn.cursor() as cur:
        for stmt in stmts:
            cur.execute(stmt)
    return len(stmts)
