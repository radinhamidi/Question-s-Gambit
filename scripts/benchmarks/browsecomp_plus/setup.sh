#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
QRELS_URL="${BROWSECOMP_PLUS_QRELS_URL:-https://raw.githubusercontent.com/texttron/BrowseComp-Plus/main/topics-qrels/qrel_evidence.txt}"
INDEX_REPO="${BROWSECOMP_PLUS_INDEX_REPO:-Tevatron/browsecomp-plus-indexes}"
INDEX_INCLUDE="${BROWSECOMP_PLUS_INDEX_INCLUDE:-bm25/*}"
INDEX_NAME="${INDEX_NAME:-browsecomp-plus-bm25-tevatron}"
ANSERINI_FATJAR_URL="${ANSERINI_FATJAR_URL:-https://repo1.maven.org/maven2/io/anserini/anserini/1.6.0/anserini-1.6.0-fatjar.jar}"
ANSERINI_THREADS="${ANSERINI_THREADS:-8}"

DATASET_ROOT="$ROOT/data/browsecomp-plus"
DST_SOURCE_QUERIES="$DATASET_ROOT/source/queries.tsv"
DST_ALL_QUERIES="$DATASET_ROOT/queries/browsecomp_plus_all.tsv"
DST_BM25_RUN="$DATASET_ROOT/source/bm25_pure.trec"
DST_QUERY_DIR="$DATASET_ROOT/queries"
DST_QRELS="$DATASET_ROOT/qrels/qrel_evidence.txt"
DST_GOLD_QRELS="$DATASET_ROOT/qrels/qrel_gold.txt"
DST_INDEX_ROOT="$ROOT/indexes"
DST_INDEX_DIR="$DST_INDEX_ROOT/$INDEX_NAME"
TMP_INDEX_DOWNLOAD_ROOT="$DST_INDEX_ROOT/.download-$INDEX_NAME"
TMP_INDEX_SOURCE_DIR="$TMP_INDEX_DOWNLOAD_ROOT/bm25"
DST_ANSERINI_JAR="$ROOT/vendor/anserini/anserini-1.6.0-fatjar.jar"

log() {
  printf '[setup:browsecomp-plus] %s\n' "$*"
}

ensure_command() {
  local command_name="$1"
  local hint="$2"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n%s\n' "$command_name" "$hint" >&2
    exit 1
  fi
}

fetch_file() {
  local url="$1"
  local output_path="$2"
  mkdir -p "$(dirname "$output_path")"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error "$url" --output "$output_path"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -O "$output_path" "$url"
    return
  fi
  printf 'Missing required downloader. Install curl or wget.\n' >&2
  exit 1
}

main() {
  cd "$ROOT"
  ensure_command uv 'Install uv from https://docs.astral.sh/uv/getting-started/installation/'
  ensure_command java 'Install Java 21 or newer so Anserini SearchCollection can generate bm25_pure.trec'

  mkdir -p \
    "$DATASET_ROOT/source" \
    "$DST_QUERY_DIR" \
    "$ROOT/data/browsecomp-plus/qrels" \
    "$ROOT/indexes" \
    "$ROOT/vendor/anserini" \
    "$ROOT/runs" \
    "$ROOT/notes"

  log "Downloading qrels from $QRELS_URL"
  fetch_file "$QRELS_URL" "$DST_QRELS"

  log "Refreshing BM25 index from Hugging Face dataset $INDEX_REPO ($INDEX_INCLUDE)"
  rm -rf "$TMP_INDEX_DOWNLOAD_ROOT" "$DST_INDEX_DIR"
  uvx --from huggingface_hub hf download \
    "$INDEX_REPO" \
    --repo-type dataset \
    --include "$INDEX_INCLUDE" \
    --local-dir "$TMP_INDEX_DOWNLOAD_ROOT"

  if [[ ! -d "$TMP_INDEX_SOURCE_DIR" ]]; then
    printf 'Expected downloaded index directory not found: %s\n' "$TMP_INDEX_SOURCE_DIR" >&2
    exit 1
  fi

  mv "$TMP_INDEX_SOURCE_DIR" "$DST_INDEX_DIR"
  rm -rf "$TMP_INDEX_DOWNLOAD_ROOT"
  rm -f "$DST_INDEX_DIR/write.lock"

  log "Downloading Anserini fatjar from $ANSERINI_FATJAR_URL"
  fetch_file "$ANSERINI_FATJAR_URL" "$DST_ANSERINI_JAR"

  log 'Decrypting BrowseComp-Plus ground truth and full query population'
  bash scripts/benchmarks/browsecomp_plus/setup_ground_truth.sh

  log "Copying decrypted full query population to $DST_SOURCE_QUERIES"
  cp "$DST_ALL_QUERIES" "$DST_SOURCE_QUERIES"

  log "Generating pure BM25 run locally with Anserini SearchCollection"
  java -cp "$DST_ANSERINI_JAR" \
    io.anserini.search.SearchCollection \
    -topicReader TsvString \
    -topics "$DST_SOURCE_QUERIES" \
    -index "$DST_INDEX_DIR" \
    -output "$DST_BM25_RUN" \
    -bm25 \
    -hits 1000 \
    -threads "$ANSERINI_THREADS"

  log 'Generating q9/q50/q100/q300/qfull slices from code-defined sampling logic'
  bash scripts/benchmarks/browsecomp_plus/generate_query_slices.sh

  touch "$ROOT/runs/.gitkeep" "$ROOT/notes/.gitkeep"

  log 'Setup complete.'
  log "Prepared assets:"
  log "- $DST_ALL_QUERIES"
  log "- $DST_SOURCE_QUERIES"
  log "- $DST_BM25_RUN"
  log "- $DST_QUERY_DIR/q9.tsv"
  log "- $DST_QUERY_DIR/q100.tsv"
  log "- $DST_QUERY_DIR/q300.tsv"
  log "- $DST_QUERY_DIR/qfull.tsv"
  log "- $DST_QRELS"
  log "- $DST_GOLD_QRELS"
  log "- $DST_INDEX_DIR"
  log "- $DST_ANSERINI_JAR"
  log "Ground truth is a separate step: set BROWSECOMP_PLUS_CANARY and run scripts/benchmarks/browsecomp_plus/setup_ground_truth.sh"
}

main "$@"
