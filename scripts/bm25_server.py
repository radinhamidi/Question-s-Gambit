#!/usr/bin/env python3
"""First-stage BM25 retrieval server, implemented with Pyserini.

Section 4.3: "all first-stage retrieval uses BM25 implemented with Pyserini", with the same
index shared by the first-move module and the agent's in-loop searches. This process owns
that index and serves every retrieval call in the system.

Protocol: newline-delimited JSON over stdio or TCP. A request is
    {"id": <int>, "type": <command>, ...params}
and the reply is
    {"id": <int>, "type": "response", "command": <command>, "success": true, "data": {...}}
or the same with "success": false and an "error" string. Under TCP the server prints one
`server_ready` line on stdout once the index is open, then accepts one request per
connection.

Commands:
    search                 query, k                        -> [{docid, score}]
    render_search_results  docids, snippet_max_chars,       -> [{docid, title, excerpt,
                           highlight_clues                      excerpt_truncated,
                                                                matched_terms}]
    read_document          docid, offset, limit             -> paginated document text
    ping                                                    -> {"ok": true}
"""
from __future__ import annotations

import argparse
import json
import re
import socket
import sys
import threading
import time

from pyserini.search.lucene import LuceneSearcher

START = time.time()
INIT_MS = 0.0


def log(msg: str) -> None:
    print(f"[bm25_server] {msg}", file=sys.stderr, flush=True)


class Index:
    """Thin wrapper over Pyserini's Lucene searcher, shared by every command."""

    def __init__(self, index_path: str, k1: float, b: float) -> None:
        self.searcher = LuceneSearcher(index_path)
        self.searcher.set_bm25(k1=k1, b=b)
        self._lock = threading.Lock()  # LuceneSearcher is not safe to share across threads
        self._doc_cache: dict[str, str] = {}

    def search(self, query: str, k: int) -> list[dict]:
        with self._lock:
            hits = self.searcher.search(query, k=k)
        return [{"docid": str(h.docid), "score": float(h.score)} for h in hits]

    def raw(self, docid: str) -> str | None:
        cached = self._doc_cache.get(docid)
        if cached is not None:
            return cached
        with self._lock:
            doc = self.searcher.doc(docid)
        if doc is None:
            return None
        raw = doc.raw()
        if raw is None:
            return None
        # Documents are stored as JSON with the text under `contents` or `text`.
        try:
            payload = json.loads(raw)
            text = payload.get("contents") or payload.get("text") or raw
        except json.JSONDecodeError:
            text = raw
        if len(self._doc_cache) < 20000:
            self._doc_cache[docid] = text
        return text


def split_front_matter(text: str) -> tuple[str, str]:
    """Return (title, body). Documents may carry a `---\ntitle: ...\n---` header."""
    if not text.startswith("---"):
        return "", text
    end = text.find("---", 3)
    if end < 0:
        return "", text
    title = ""
    for line in text[3:end].split("\n"):
        if line.startswith("title:"):
            title = line[len("title:"):].strip()
            break
    return title, text[end + 3:].lstrip("\n")


def excerpt_for(body: str, clues: list[str], max_chars: int) -> tuple[str, bool, list[str]]:
    """A window around the first matched clue, else the head of the document."""
    lowered = body.lower()
    matched = [c for c in clues if c and c.lower() in lowered]
    start = 0
    if matched:
        pos = lowered.find(matched[0].lower())
        start = max(0, pos - max_chars // 4)
    window = body[start:start + max_chars]
    return " ".join(window.split()), len(body) > start + max_chars, matched


def handle(index: Index, req: dict) -> dict:
    command = req.get("type", "")
    t0 = time.time()

    if command == "ping":
        return {"ok": True}

    if command == "search":
        query = str(req.get("query", ""))
        k = int(req.get("k") or 10)
        results = index.search(query, k) if query.strip() else []
        return {
            "mode": "search",
            "query": query,
            "k": k,
            "results": results,
            "timing_ms": timing(t0),
        }

    if command == "render_search_results":
        docids = [str(d) for d in (req.get("docids") or [])]
        max_chars = int(req.get("snippet_max_chars") or 300)
        clues = [str(c) for c in (req.get("highlight_clues") or [])]
        results = []
        for docid in docids:
            text = index.raw(docid)
            if text is None:
                results.append(
                    {"docid": docid, "title": None, "excerpt": "", "excerpt_truncated": False}
                )
                continue
            title, body = split_front_matter(text)
            excerpt, truncated, matched = excerpt_for(body, clues, max_chars)
            results.append(
                {
                    "docid": docid,
                    "title": title or None,
                    "excerpt": excerpt,
                    "excerpt_truncated": truncated,
                    "matched_terms": matched,
                }
            )
        return {
            "mode": "render_search_results",
            "docids": docids,
            "results": results,
            "timing_ms": timing(t0),
        }

    if command == "read_document":
        docid = str(req.get("docid", ""))
        offset = max(1, int(req.get("offset") or 1))
        limit = max(1, int(req.get("limit") or 200))
        text = index.raw(docid)
        if text is None:
            return {
                "mode": "read_document",
                "docid": docid,
                "found": False,
                "timing_ms": timing(t0),
            }
        lines = text.split("\n")
        start = offset - 1
        end = min(len(lines), start + limit)
        chunk = "\n".join(lines[start:end])
        truncated = end < len(lines)
        return {
            "mode": "read_document",
            "docid": docid,
            "found": True,
            "text": chunk,
            "offset": offset,
            "limit": limit,
            "total_lines": len(lines),
            "returned_line_start": min(offset, len(lines)),
            "returned_line_end": end,
            "truncated": truncated,
            "next_offset": end + 1 if truncated else None,
            "timing_ms": timing(t0),
        }

    raise ValueError(f"unknown command: {command!r}")


def timing(t0: float) -> dict:
    return {
        "command": round((time.time() - t0) * 1000, 3),
        "init": round(INIT_MS, 3),
        "server_uptime": round((time.time() - START) * 1000, 3),
    }


def respond(req: dict, index: Index) -> str:
    rid = req.get("id")
    command = req.get("type", "")
    try:
        data = handle(index, req)
        reply = {"id": rid, "type": "response", "command": command, "success": True, "data": data}
    except Exception as err:  # a failed command must not take the server down
        reply = {
            "id": rid,
            "type": "response",
            "command": command,
            "success": False,
            "error": f"{type(err).__name__}: {err}",
        }
    return json.dumps(reply, ensure_ascii=False)


def serve_stdio(index: Index) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        print(respond(req, index), flush=True)


def serve_tcp(index: Index, host: str, port: int) -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(128)
    bound_host, bound_port = srv.getsockname()
    print(
        json.dumps(
            {
                "type": "server_ready",
                "transport": "tcp",
                "host": bound_host,
                "port": bound_port,
                "timing_ms": {"init": round(INIT_MS, 3)},
            }
        ),
        flush=True,
    )

    def client(conn: socket.socket) -> None:
        with conn:
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            line, _, _ = buf.partition(b"\n")
            try:
                req = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                return
            conn.sendall((respond(req, index) + "\n").encode("utf-8"))

    while True:
        conn, _ = srv.accept()
        threading.Thread(target=client, args=(conn,), daemon=True).start()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--index-path", required=True)
    ap.add_argument("--k1", type=float, required=True)
    ap.add_argument("--b", type=float, required=True)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--transport", choices=["stdio", "tcp"], default="stdio")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()

    global INIT_MS
    t0 = time.time()
    index = Index(args.index_path, args.k1, args.b)
    INIT_MS = (time.time() - t0) * 1000
    log(f"index={args.index_path} k1={args.k1} b={args.b} init={INIT_MS:.0f}ms")

    if args.transport == "tcp":
        serve_tcp(index, args.host, args.port)
    else:
        serve_stdio(index)
    return 0


if __name__ == "__main__":
    sys.exit(main())
