#!/bin/bash
# Run one experimental arm end-to-end (Stage 1 agent benchmark → Stage 2 codex
# judge → Stage 3 retrieval-only eval) on a local machine.
#
# This is the "no SLURM" equivalent of the per-arm launcher used in the
# experiments. Set the AGENT_MODEL / ARM_TAG knobs via env
# vars, source .env first to load API keys.
#
# Usage:
#   bash scripts/run_arm.sh
#
# Defaults below reproduce the gpt-5.5 main-result arm. To run a different
# arm, set AGENT_MODEL (e.g. openrouter/deepseek/deepseek-v4-pro) at the
# command line:
#   AGENT_MODEL=openrouter/deepseek/deepseek-v4-pro bash scripts/run_arm.sh
#
# To run the MultiHop-RAG control benchmark instead of BrowseComp-Plus:
#   BENCHMARK=multihoprag QUERY_SET=mh200 bash scripts/run_arm.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- load .env ----------
if [[ -f .env ]]; then
  set -a; source .env; set +a
fi

# ---------- agent + benchmark knobs (override via env at submit time) ----------
BENCHMARK="${BENCHMARK:-browsecomp-plus}"
QUERY_SET="${QUERY_SET:-qfull}"
AGENT_MODEL="${AGENT_MODEL:-${MODEL:-openai/gpt-5.5}}"
SHARD_COUNT="${SHARD_COUNT:-16}"
BM25_THREADS="${BM25_THREADS:-8}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-900}"
ARM_TAG="${ARM_TAG:-qg5_live_coherepro}"


# Codex judge knobs (replaces self-judge)
RUN_CODEX_JUDGE="${RUN_CODEX_JUDGE:-1}"
CODEX_JUDGE_MODEL="${CODEX_JUDGE_MODEL:-openai-codex/gpt-5.3-codex}"
CODEX_JUDGE_CONCURRENCY="${CODEX_JUDGE_CONCURRENCY:-16}"

# Required key sanity
require_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is required. Set it in .env or in your shell."
    exit 2
  fi
}
case "$AGENT_MODEL" in
  openrouter/*)    require_env OPENROUTER_API_KEY ;;
esac
# Clue expansion always runs on OpenAI, whichever agent is selected.
require_env OPENAI_API_KEY
require_env OPENROUTER_API_KEY   # Cohere reranker

# Dir / tag derivation
QG_MODEL_TAG="gpt-4-1"
AGENT_MODEL_TAG="$(echo "$AGENT_MODEL" | tr -d '.' | tr '/' '_')"
ARM_DIR="runs/pi_bm25_${BENCHMARK}_${QUERY_SET}_qg_dx_${QG_MODEL_TAG}_${AGENT_MODEL_TAG}_${ARM_TAG}"
SHARED_LOG_DIR="runs/shared-bm25-${BENCHMARK}-${QUERY_SET}_qg_dx_${QG_MODEL_TAG}_${AGENT_MODEL_TAG}_${ARM_TAG}"
mkdir -p "$ARM_DIR" "$SHARED_LOG_DIR"

# JVM tuning for the BM25 RPC server (Anserini)
export _JAVA_OPTIONS="${_JAVA_OPTIONS:--Xmx12g -Xms2g -XX:MaxDirectMemorySize=2g}"

# Per-arm experiment knobs (read by query_set_sharded_shared_bm25.ts +
# extension.ts + constraint_decomp.ts).
export BENCHMARK QUERY_SET TIMEOUT_SECONDS
export MODEL="$AGENT_MODEL"
export OUTPUT_DIR="$ARM_DIR"
export LOG_DIR="$SHARED_LOG_DIR"
export SHARD_COUNT
export PI_BM25_THREADS="$BM25_THREADS"

echo "============================================================"
echo "  Question-Gambit — arm run"
echo "  Date:             $(date '+%F %T %Z')"
echo "  AGENT_MODEL:      $AGENT_MODEL"
echo "  BENCHMARK:        $BENCHMARK"
echo "  QUERY_SET:        $QUERY_SET"
echo "  SHARD_COUNT:      $SHARD_COUNT"
echo "  BM25_THREADS:     $BM25_THREADS"
echo "  TIMEOUT_SECONDS:  $TIMEOUT_SECONDS"
echo "  ARM_DIR:          $ARM_DIR"
echo "============================================================"

# Stage 1: sharded agent benchmark
echo
echo "============================================================"
echo "  Stage 1: sharded agent benchmark"
echo "============================================================"
node_modules/.bin/tsx src/orchestration/query_set_sharded_shared_bm25.ts

MERGED_DIR="$ARM_DIR/merged"
ARM_BASENAME="$(basename "$ARM_DIR")"
if [[ ! -d "$MERGED_DIR" ]]; then
  echo "no merged dir at $MERGED_DIR; skipping judge + retrieval eval"
  exit 0
fi

# Stage 2: codex judge (cross-arm comparable, fixed model)
if [[ "$RUN_CODEX_JUDGE" == "1" ]]; then
  CODEX_EVAL_DIR="evals/pi_judge_codex53/$BENCHMARK/$ARM_BASENAME"
  echo
  echo "============================================================"
  echo "  Stage 2: codex judge ($CODEX_JUDGE_MODEL, concurrency $CODEX_JUDGE_CONCURRENCY)"
  echo "============================================================"
  node_modules/.bin/tsx scripts/judge_arm_concurrent.ts \
    --armDir "$ARM_DIR" \
    --benchmark "$BENCHMARK" \
    --judge-model "$CODEX_JUDGE_MODEL" \
    --eval-dir "$CODEX_EVAL_DIR" \
    --concurrency "$CODEX_JUDGE_CONCURRENCY"

  # Gold qrels are a BrowseComp-Plus distinction (gold = the evidence documents that also
  # contain the answer). MultiHop-RAG has a single relevance set, so this stage is skipped
  # there by the -f test below rather than being reported against the wrong qrels.
  GOLD_QRELS="data/${BENCHMARK}/qrels/qrel_gold.txt"
  CODEX_PER_QUERY_DIR="$CODEX_EVAL_DIR/per-query"
  CODEX_GOLD_SUMMARY="evals/pi_judge_gold_codex53/$BENCHMARK/$ARM_BASENAME/recall_summary.json"
  if [[ -d "$CODEX_PER_QUERY_DIR" && -f "$GOLD_QRELS" ]]; then
    echo
    echo "============================================================"
    echo "  Stage 2b: gold-qrel recall panel"
    echo "============================================================"
    PER_QUERY_DIR="$CODEX_PER_QUERY_DIR" \
    QRELS_PATH="$GOLD_QRELS" \
    LABEL=gold \
    OUTPUT_PATH="$CODEX_GOLD_SUMMARY" \
      node_modules/.bin/tsx scripts/recall_against_qrels.ts || echo "(stage 2b non-fatal)"
  fi
fi

# Stage 3: retrieval-only eval (BM25 ranking quality vs qrels)
echo
echo "============================================================"
echo "  Stage 3: retrieval-only eval"
echo "============================================================"
node_modules/.bin/tsx src/wrappers/evaluate_retrieval_entry.ts \
  --benchmark "$BENCHMARK" \
  --query-set "$QUERY_SET" \
  --run-dir "$MERGED_DIR" || true

echo
echo "============================================================"
echo "=== arm complete at $(date '+%F %T %Z') ==="
echo "  ARM_DIR:        $ARM_DIR"
echo "  judge summary:  evals/pi_judge_codex53/$BENCHMARK/$ARM_BASENAME/evaluation_summary.json"
echo "  gold-recall:    evals/pi_judge_gold_codex53/$BENCHMARK/$ARM_BASENAME/recall_summary.json"
echo "============================================================"
