#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUTPUT_JSONL="${OUTPUT_JSONL:-$ROOT/data/browsecomp-plus/ground-truth/browsecomp_plus_decrypted.jsonl}"
OUTPUT_TSV="${OUTPUT_TSV:-$ROOT/data/browsecomp-plus/queries/browsecomp_plus_all.tsv}"
OUTPUT_GOLD_QRELS="${OUTPUT_GOLD_QRELS:-$ROOT/data/browsecomp-plus/qrels/qrel_gold.txt}"
CACHE_DIR="${CACHE_DIR:-$ROOT/data/hf-cache/browsecomp-plus}"
DATASET_REPO="${BROWSECOMP_PLUS_DATASET_REPO:-Tevatron/browsecomp-plus}"
CANARY="${BROWSECOMP_PLUS_CANARY:-}"

if [[ -z "$CANARY" ]]; then
  echo "BROWSECOMP_PLUS_CANARY must be set to decrypt BrowseComp-Plus ground-truth assets." >&2
  echo "Refusing to use a built-in default secret from tracked source." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_JSONL")" "$(dirname "$OUTPUT_TSV")" "$(dirname "$OUTPUT_GOLD_QRELS")" "$CACHE_DIR"

uv run --no-project \
  --with datasets \
  --with huggingface_hub \
  python - <<'PY' "$DATASET_REPO" "$CACHE_DIR" "$OUTPUT_JSONL" "$OUTPUT_TSV" "$OUTPUT_GOLD_QRELS" "$CANARY"
import base64
import hashlib
import json
import sys
from pathlib import Path

from datasets import load_dataset
from huggingface_hub import dataset_info, hf_hub_download

repo_id, cache_dir_raw, output_jsonl_raw, output_tsv_raw, output_gold_qrels_raw, canary = sys.argv[1:7]
cache_dir = Path(cache_dir_raw)
output_jsonl = Path(output_jsonl_raw)
output_tsv = Path(output_tsv_raw)
output_gold_qrels = Path(output_gold_qrels_raw)


def derive_key(password: str, length: int) -> bytes:
    hasher = hashlib.sha256()
    hasher.update(password.encode("utf-8"))
    key = hasher.digest()
    return key * (length // len(key)) + key[: length % len(key)]


def decrypt_string(ciphertext_b64: str, password: str) -> str:
    encrypted = base64.b64decode(ciphertext_b64)
    key = derive_key(password, len(encrypted))
    decrypted = bytes(a ^ b for a, b in zip(encrypted, key))
    return decrypted.decode("utf-8")


def transform_decrypt(obj, password: str, skip_keys: set[str]):
    if isinstance(obj, str):
        return decrypt_string(obj, password)
    if isinstance(obj, list):
        return [transform_decrypt(value, password, skip_keys) for value in obj]
    if isinstance(obj, dict):
        output = {}
        for key, value in obj.items():
            output[key] = value if key in skip_keys else transform_decrypt(value, password, skip_keys)
        return output
    return obj


info = dataset_info(repo_id, files_metadata=True)
shards = sorted(
    sibling.rfilename
    for sibling in info.siblings
    if sibling.rfilename.startswith("data/test-") and sibling.rfilename.endswith(".parquet")
)
if not shards:
    raise RuntimeError(f"No test parquet shards found in {repo_id}")

local_files = []
for index, shard in enumerate(shards, start=1):
    print(f"[{index}/{len(shards)}] Downloading {shard}...", flush=True)
    local_files.append(
        hf_hub_download(
            repo_id=repo_id,
            repo_type="dataset",
            filename=shard,
            local_dir=str(cache_dir),
        )
    )

dataset = load_dataset("parquet", data_files={"test": local_files}, split="test")
skip_keys = {"query_id"}
output_jsonl.parent.mkdir(parents=True, exist_ok=True)
output_tsv.parent.mkdir(parents=True, exist_ok=True)
output_gold_qrels.parent.mkdir(parents=True, exist_ok=True)
with (
    output_jsonl.open("w", encoding="utf-8") as jsonl_out,
    output_tsv.open("w", encoding="utf-8") as tsv_out,
    output_gold_qrels.open("w", encoding="utf-8") as gold_qrels_out,
):
    for row in dataset:
        decrypted = transform_decrypt(row, canary, skip_keys)
        json.dump(decrypted, jsonl_out, ensure_ascii=False)
        jsonl_out.write("\n")

        query_id = str(decrypted.get("query_id", "")).strip()
        query_text = str(decrypted.get("query", "")).replace("\t", " ")
        tsv_out.write(f"{query_id}\t{query_text}\n")

        if not query_id:
            continue
        seen_docids: set[str] = set()
        for doc in decrypted.get("gold_docs", []):
            if not isinstance(doc, dict):
                continue
            docid = str(doc.get("docid", "")).strip()
            if not docid or docid in seen_docids:
                continue
            seen_docids.add(docid)
            gold_qrels_out.write(f"{query_id} 0 {docid} 1\n")

print(f"Wrote decrypted JSONL to {output_jsonl}", flush=True)
print(f"Wrote TSV to {output_tsv}", flush=True)
print(f"Wrote gold qrels to {output_gold_qrels}", flush=True)
PY
