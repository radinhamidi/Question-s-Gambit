#!/usr/bin/env python3
"""Convert the MultiHopRAG source release (HF yixuantt/MultiHopRAG) into the
harness's benchmark layout:

  data/multihoprag/corpus/docs.jsonl          Anserini JsonCollection input
  data/multihoprag/queries/{mhfull,mh200,mh20}.tsv
  data/multihoprag/qrels/qrel_evidence.txt    evidence docs, grade 1
  data/multihoprag/ground-truth/ground_truth.jsonl

Docids are the corpus array index as a string. Evidence maps to docids via URL
(verified 100% coverage: 6084/6084 evidence entries resolve).

Doc `contents` mirror the BrowseComp-Plus stored format (markdown front-matter
with a `title:` line, then body) so read_document / preview enrichment work
unchanged. We additionally include source / published_at / category in the
front-matter because MultiHopRAG's temporal and source-attribution questions
require them and the article bodies do not reliably contain them.

Slices (deterministic, no RNG): proportional stratification by question_type,
picking every k-th question within each type in source order.
  mhfull = all 2,556
  mh200  = 200 (64 inference / 67 comparison / 46 temporal / 23 null)
  mh20   = 20  (5 per type) — smoke slice
"""
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SRC = os.path.join(ROOT, "data", "multihoprag", "source")
OUT = os.path.join(ROOT, "data", "multihoprag")

corpus = json.load(open(os.path.join(SRC, "corpus.json")))
queries = json.load(open(os.path.join(SRC, "MultiHopRAG.json")))

# ---------------- corpus ----------------
os.makedirs(os.path.join(OUT, "corpus"), exist_ok=True)
by_url = {}
with open(os.path.join(OUT, "corpus", "docs.jsonl"), "w") as fh:
    for i, d in enumerate(corpus):
        docid = str(i)
        by_url[d["url"]] = docid
        date = (d.get("published_at") or "")[:10]
        contents = (
            f"---\ntitle: {d['title']}\nsource: {d.get('source', '')}\n"
            f"published_at: {date}\ncategory: {d.get('category', '')}\n---\n{d['body']}"
        )
        fh.write(json.dumps({"id": docid, "contents": contents}) + "\n")
print(f"corpus: {len(corpus)} docs")

# ---------------- queries + qrels + ground truth ----------------
os.makedirs(os.path.join(OUT, "queries"), exist_ok=True)
os.makedirs(os.path.join(OUT, "qrels"), exist_ok=True)
os.makedirs(os.path.join(OUT, "ground-truth"), exist_ok=True)


def clean(s):
    return " ".join(str(s).split())


rows = []  # (qid, type, question, answer, evidence_docids)
unmapped = 0
for i, q in enumerate(queries):
    ev = []
    for e in q["evidence_list"]:
        d = by_url.get(e["url"])
        if d is None:
            unmapped += 1
            continue
        if d not in ev:
            ev.append(d)
    rows.append((str(i), q["question_type"], clean(q["query"]), clean(q["answer"]), ev))
assert unmapped == 0, f"{unmapped} evidence entries failed to map"

with open(os.path.join(OUT, "qrels", "qrel_evidence.txt"), "w") as fh:
    for qid, _t, _q, _a, ev in rows:
        for d in ev:
            fh.write(f"{qid} Q0 {d} 1\n")

doc_excerpt = {}
for i, d in enumerate(corpus):
    doc_excerpt[str(i)] = clean(d["body"])[:200]

with open(os.path.join(OUT, "ground-truth", "ground_truth.jsonl"), "w") as fh:
    for qid, _t, question, answer, ev in rows:
        docs = [{"docid": d, "text": doc_excerpt[d]} for d in ev]
        fh.write(
            json.dumps(
                {
                    "query_id": qid,
                    "query": question,
                    "answer": answer,
                    "gold_docs": docs,
                    "evidence_docs": docs,
                    "negative_docs": [],
                }
            )
            + "\n"
        )

# ---------------- slices ----------------
TYPES = ["inference_query", "comparison_query", "temporal_query", "null_query"]
by_type = {t: [r for r in rows if r[1] == t] for t in TYPES}
total = len(rows)


def stratified(n_target):
    picked = []
    for t in TYPES:
        pool = by_type[t]
        n_t = max(1, round(n_target * len(pool) / total))
        step = len(pool) / n_t
        idxs = sorted({int(j * step) for j in range(n_t)})
        picked.extend(pool[j] for j in idxs)
    return picked[:n_target] if len(picked) > n_target else picked


def stratified_fixed(per_type):
    picked = []
    for t in TYPES:
        pool = by_type[t]
        step = len(pool) / per_type
        idxs = sorted({int(j * step) for j in range(per_type)})
        picked.extend(pool[j] for j in idxs)
    return picked


slices = {
    "mhfull": rows,
    "mh200": stratified(200),
    "mh20": stratified_fixed(5),
}
for name, rs in slices.items():
    with open(os.path.join(OUT, "queries", f"{name}.tsv"), "w") as fh:
        for qid, _t, question, _a, _ev in rs:
            fh.write(f"{qid}\t{question}\n")
    from collections import Counter

    print(f"{name}: {len(rs)} queries  {dict(Counter(r[1] for r in rs))}")

print("qrels lines:", sum(len(r[4]) for r in rows))
