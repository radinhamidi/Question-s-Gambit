#!/usr/bin/env bash
# First-stage BM25 retrieval server (Pyserini). Launched by the orchestrator; see
# scripts/bm25_server.py for the protocol.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "${PYTHON:-python3}" "$REPO_ROOT/scripts/bm25_server.py" "$@"
