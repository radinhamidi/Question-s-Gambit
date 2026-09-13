#!/usr/bin/env bash
set -euo pipefail

# MultiHopRAG benchmark setup: download HF release, build harness data files,
# index the corpus with Anserini, generate the baseline BM25 run.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC="$ROOT/data/multihoprag/source"
INDEX_DIR="$ROOT/indexes/multihoprag-bm25"
ANSERINI_JAR="$ROOT/vendor/anserini/anserini-1.6.0-fatjar.jar"

log() { printf '[setup:multihoprag] %s\n' "$*"; }

cd "$ROOT"

if [[ ! -f "$SRC/corpus.json" || ! -f "$SRC/MultiHopRAG.json" ]]; then
  log "Downloading MultiHopRAG from HF (yixuantt/MultiHopRAG)"
  uvx --from huggingface_hub hf download yixuantt/MultiHopRAG --repo-type dataset --local-dir "$SRC"
fi

log "Building corpus/queries/qrels/ground-truth"
python3 scripts/benchmarks/multihoprag/build_data.py

log "Indexing with Anserini"
rm -rf "$INDEX_DIR"
java -cp "$ANSERINI_JAR" io.anserini.index.IndexCollection \
  -collection JsonCollection -generator DefaultLuceneDocumentGenerator \
  -threads 1 -input data/multihoprag/corpus -index "$INDEX_DIR" \
  -storePositions -storeDocvectors -storeRaw -optimize
rm -f "$INDEX_DIR/write.lock"

log "Baseline BM25 runs (tuned k1=25,b=1 + Anserini default)"
for PARAMS in "25 1" "0.9 0.4"; do
  set -- $PARAMS
  java -cp "$ANSERINI_JAR" io.anserini.search.SearchCollection \
    -topicReader TsvString -topics data/multihoprag/queries/mhfull.tsv \
    -index "$INDEX_DIR" -output "data/multihoprag/source/bm25_k1-$1_b-$2.trec" \
    -bm25 -bm25.k1 "$1" -bm25.b "$2" -hits 609 -threads 2
done
ln -sf bm25_k1-25_b-1.trec data/multihoprag/source/bm25_pure.trec

log "Done. Index: $INDEX_DIR"
