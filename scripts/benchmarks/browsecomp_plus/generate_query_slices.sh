#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

DATASET_ROOT="${DATASET_ROOT:-data/browsecomp-plus}"
SOURCE_QUERIES_PATH="${SOURCE_QUERIES_PATH:-$DATASET_ROOT/source/queries.tsv}"
QRELS_PATH="${QRELS_PATH:-$DATASET_ROOT/qrels/qrel_evidence.txt}"
PURE_BM25_RUN_PATH="${PURE_BM25_RUN_PATH:-$DATASET_ROOT/source/bm25_pure.trec}"
OUTPUT_DIR="${OUTPUT_DIR:-$DATASET_ROOT/queries}"
SEED="${SEED:-42}"

printf 'SOURCE_QUERIES_PATH=%s\n' "$SOURCE_QUERIES_PATH"
printf 'QRELS_PATH=%s\n' "$QRELS_PATH"
printf 'PURE_BM25_RUN_PATH=%s\n' "$PURE_BM25_RUN_PATH"
printf 'OUTPUT_DIR=%s\n' "$OUTPUT_DIR"
printf 'SEED=%s\n' "$SEED"

uv run --no-project python3 scripts/generate_browsecomp_plus_query_slices.py \
  --queries "$SOURCE_QUERIES_PATH" \
  --qrels "$QRELS_PATH" \
  --bm25-run "$PURE_BM25_RUN_PATH" \
  --output-dir "$OUTPUT_DIR" \
  --seed "$SEED" \
  "$@"
