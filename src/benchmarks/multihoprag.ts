import type { BenchmarkDefinition } from "./types";

// MultiHop-RAG (Tang & Yang, 2024) — the control benchmark reported in the paper.
// 2,556 queries over a fixed 609-article news corpus, in four question types
// (inference / comparison / temporal / null). Evidence annotations resolve to
// corpus documents by URL with full coverage.
//
// The paper evaluates the `mh200` slice: a deterministic, proportionally
// stratified sample of 200 questions spanning all four types (no RNG — every
// k-th question within each type, in source order), so the slice is
// reproducible from the released data without shipping an id list.
//
// Data and index are built by scripts/benchmarks/multihoprag/setup.sh from the
// HuggingFace release (yixuantt/MultiHopRAG) into data/multihoprag/source/.
// Unlike BrowseComp-Plus there is no gold-vs-evidence distinction here, so the
// evidence qrels serve as the single relevance set.
export const multihopragBenchmark: BenchmarkDefinition = {
  id: "multihoprag",
  aliases: ["multihop-rag", "multihop_rag", "mhrag"],
  displayName: "MultiHop-RAG",
  datasetId: "multihoprag",
  piSearchPromptVariant: "plain_minimal",
  defaultQuerySetId: "mh200",
  defaultQueryPath: "data/multihoprag/queries/mh200.tsv",
  querySets: {
    // 20-question smoke slice (5 per type) for checking a config end-to-end.
    mh20: "data/multihoprag/queries/mh20.tsv",
    // The slice reported in the paper.
    mh200: "data/multihoprag/queries/mh200.tsv",
    mhfull: "data/multihoprag/queries/mhfull.tsv",
  },
  defaultQrelsPath: "data/multihoprag/qrels/qrel_evidence.txt",
  defaultGroundTruthPath: "data/multihoprag/ground-truth/ground_truth.jsonl",
  defaultIndexPath: "indexes/multihoprag-bm25",
  defaultCompareQuerySetId: "mhfull",
  defaultBaselineRunPath: "data/multihoprag/source/bm25_pure.trec",
  managedPresets: {},
  setup: {
    steps: {
      setup: "scripts/benchmarks/multihoprag/setup.sh",
    },
  },
  retrievalEvaluation: {
    runFileBackend: "internal",
    runDirBackend: "internal",
  },
  judgeEvaluation: {
    supportedModes: ["gold-answer", "reference-free"],
    defaultMode: "gold-answer",
  },
};
