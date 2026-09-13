#!/usr/bin/env python3
import argparse
import math
import random
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

DEFAULT_ALLOCATIONS = {
    "zero_small": 10,
    "zero_large": 20,
    "tiny_large": 10,
    "low_small": 10,
    "low_large": 10,
    "medium_small": 10,
    "medium_large": 10,
    "high_small": 10,
    "high_large": 10,
}

Q9_QUERY_IDS = ["25", "30", "244", "549", "655", "1019", "1032", "1127", "1219"]


@dataclass(frozen=True)
class QueryRecord:
    query_id: str
    query_text: str
    pure_bm25_recall: float
    gold_docs: int
    difficulty_bin: str
    gold_bin: str
    stratum: str


class SliceGenerationError(RuntimeError):
    pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate the BrowseComp-Plus q9/q50/q100/q300/qfull query slices. "
            "q9 is a fixed code-defined slice matching the historical original workspace; "
            "q100 and q300 are seeded stratified samples derived from pure BM25 recall and gold-doc strata; "
            "qfull is the full query set."
        )
    )
    parser.add_argument(
        "--queries",
        required=True,
        help="Path to the full TSV query file with columns query_id<TAB>query.",
    )
    parser.add_argument(
        "--qrels",
        required=True,
        help="Path to the evidence qrels file.",
    )
    parser.add_argument(
        "--bm25-run",
        required=True,
        help="Path to the pure BM25 TREC run file.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory where q9.tsv, q50.tsv, q100.tsv, q300.tsv, and qfull.tsv will be written.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for the stratified q100/q300 sampling logic.",
    )
    parser.add_argument(
        "--slices",
        nargs="+",
        default=["q9", "q50", "q100", "q300", "qfull"],
        help="Slices to generate. Supported: q9 q50 q100 q300 qfull",
    )
    return parser.parse_args()


def iter_queries(path: Path) -> Iterable[tuple[str, str]]:
    with path.open("r", encoding="utf-8") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            line = raw_line.rstrip("\n")
            if not line:
                continue
            parts = line.split("\t", 1)
            if len(parts) != 2:
                raise SliceGenerationError(
                    f"Invalid query TSV line {line_no}: expected query_id<TAB>query"
                )
            yield parts[0], parts[1]


def load_qrels(path: Path) -> dict[str, set[str]]:
    qrels: dict[str, set[str]] = defaultdict(set)
    with path.open("r", encoding="utf-8") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            parts = raw_line.split()
            if len(parts) < 4:
                raise SliceGenerationError(
                    f"Invalid qrels line {line_no}: expected at least 4 columns"
                )
            qid, _, docid, rel = parts[:4]
            if rel != "0":
                qrels[qid].add(docid)
    return qrels


def load_run_topk(path: Path, top_k: int = 1000) -> dict[str, list[str]]:
    run: dict[str, list[str]] = defaultdict(list)
    with path.open("r", encoding="utf-8") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            parts = raw_line.split()
            if len(parts) != 6:
                raise SliceGenerationError(
                    f"Invalid TREC run line {line_no}: expected 6 columns"
                )
            qid, _, docid, rank, _, _ = parts
            if int(rank) <= top_k:
                run[qid].append(docid)
    return run


def difficulty_bin(recall: float) -> str:
    if recall == 0.0:
        return "zero"
    if recall <= 0.1:
        return "tiny"
    if recall <= 0.25:
        return "low"
    if recall <= 0.5:
        return "medium"
    return "high"


def gold_bin(gold_docs: int) -> str:
    return "small" if gold_docs <= 5 else "large"


def build_population(
    queries_path: Path, qrels_path: Path, bm25_run_path: Path
) -> list[QueryRecord]:
    queries = dict(iter_queries(queries_path))
    qrels = load_qrels(qrels_path)
    run = load_run_topk(bm25_run_path, top_k=1000)

    missing_queries = sorted(set(qrels) - set(queries), key=int)
    if missing_queries:
        raise SliceGenerationError(
            f"{len(missing_queries)} qids are present in qrels but missing from queries.tsv; first few: {missing_queries[:5]}"
        )

    records: list[QueryRecord] = []
    for qid in sorted(qrels, key=int):
        gold = qrels[qid]
        retrieved = set(run.get(qid, []))
        recall = len(retrieved & gold) / len(gold) if gold else 0.0
        gold_docs = len(gold)
        diff = difficulty_bin(recall)
        gold_group = gold_bin(gold_docs)
        records.append(
            QueryRecord(
                query_id=qid,
                query_text=queries[qid],
                pure_bm25_recall=recall,
                gold_docs=gold_docs,
                difficulty_bin=diff,
                gold_bin=gold_group,
                stratum=f"{diff}_{gold_group}",
            )
        )
    return records


def derive_weighted_allocations(
    total_sample_size: int,
    existing_records: list[QueryRecord],
    population_counts: Counter,
    weights: dict[str, int],
) -> dict[str, int]:
    if total_sample_size < len(existing_records):
        raise SliceGenerationError(
            f"Requested total sample size {total_sample_size} is smaller than the existing sample size {len(existing_records)}"
        )

    existing_counts = Counter(record.stratum for record in existing_records)
    remaining_needed = total_sample_size - len(existing_records)
    capacities = {
        stratum: population_counts[stratum] - existing_counts[stratum] for stratum in weights
    }

    if remaining_needed > sum(capacities.values()):
        raise SliceGenerationError(
            f"Requested {remaining_needed} additional queries, but only {sum(capacities.values())} remain after exclusions"
        )

    allocations = {stratum: 0 for stratum in weights}
    remaining = remaining_needed
    active = {
        stratum
        for stratum, weight in weights.items()
        if weight > 0 and capacities.get(stratum, 0) > 0
    }

    while remaining > 0:
        if not active:
            raise SliceGenerationError(
                f"Unable to allocate the final {remaining} queries; all strata are exhausted"
            )

        weight_sum = sum(weights[stratum] for stratum in active)
        if weight_sum <= 0:
            raise SliceGenerationError("Active stratum weights must sum to a positive number")

        raw_targets = {
            stratum: remaining * weights[stratum] / weight_sum for stratum in active
        }
        floor_allocations = {
            stratum: min(
                capacities[stratum] - allocations[stratum],
                math.floor(raw_targets[stratum]),
            )
            for stratum in active
        }
        assigned_this_round = sum(floor_allocations.values())

        if assigned_this_round == 0:
            ordered = sorted(
                active,
                key=lambda stratum: (
                    raw_targets[stratum],
                    weights[stratum],
                    population_counts[stratum],
                    stratum,
                ),
                reverse=True,
            )
            for stratum in ordered:
                if remaining == 0:
                    break
                if allocations[stratum] >= capacities[stratum]:
                    continue
                allocations[stratum] += 1
                remaining -= 1
                if allocations[stratum] >= capacities[stratum]:
                    active.remove(stratum)
            continue

        for stratum, amount in floor_allocations.items():
            if amount <= 0:
                continue
            allocations[stratum] += amount
            remaining -= amount

        exhausted = {
            stratum
            for stratum in list(active)
            if allocations[stratum] >= capacities[stratum]
        }
        active -= exhausted

        if remaining == 0:
            break

        remainders = sorted(
            active,
            key=lambda stratum: (
                raw_targets[stratum] - math.floor(raw_targets[stratum]),
                weights[stratum],
                population_counts[stratum],
                stratum,
            ),
            reverse=True,
        )
        for stratum in remainders:
            if remaining == 0:
                break
            if allocations[stratum] >= capacities[stratum]:
                continue
            allocations[stratum] += 1
            remaining -= 1
            if allocations[stratum] >= capacities[stratum]:
                active.remove(stratum)

    return {
        stratum: existing_counts[stratum] + allocations[stratum] for stratum in weights
    }


def validate_allocations(records: list[QueryRecord], allocations: dict[str, int]) -> None:
    population_counts = Counter(record.stratum for record in records)
    unknown = sorted(set(allocations) - set(population_counts))
    if unknown:
        raise SliceGenerationError(f"Allocations reference unknown strata: {unknown}")

    oversubscribed = sorted(
        (
            stratum,
            requested,
            population_counts[stratum],
        )
        for stratum, requested in allocations.items()
        if requested > population_counts[stratum]
    )
    if oversubscribed:
        details = "; ".join(
            f"{stratum}: requested {requested}, population {population}"
            for stratum, requested, population in oversubscribed
        )
        raise SliceGenerationError(
            f"Requested more queries than available in some strata: {details}"
        )


def sample_records(
    records: list[QueryRecord], allocations: dict[str, int], seed: int
) -> list[QueryRecord]:
    by_stratum: dict[str, list[QueryRecord]] = defaultdict(list)
    for record in records:
        by_stratum[record.stratum].append(record)

    rng = random.Random(seed)
    sampled: list[QueryRecord] = []
    for stratum in sorted(allocations):
        requested = allocations[stratum]
        if requested <= 0:
            continue
        population = sorted(by_stratum[stratum], key=lambda record: int(record.query_id))
        sampled.extend(rng.sample(population, requested))

    return sorted(sampled, key=lambda record: int(record.query_id))


def write_slice(path: Path, records: list[QueryRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(f"{record.query_id}\t{record.query_text}\n")


def build_q9(population_by_qid: dict[str, QueryRecord]) -> list[QueryRecord]:
    missing = [qid for qid in Q9_QUERY_IDS if qid not in population_by_qid]
    if missing:
        raise SliceGenerationError(
            f"q9 definition references unknown query ids: {', '.join(missing)}"
        )
    return [population_by_qid[qid] for qid in Q9_QUERY_IDS]


def build_q50(records: list[QueryRecord], q100_records: list[QueryRecord]) -> list[QueryRecord]:
    """The 50-question development subset: the first half of q100, in q100 order.

    Derived from q100 rather than sampled independently so the development subset is a
    strict subset of the larger slice and is reproducible from the same seed.
    """
    return q100_records[:50]


def build_q100(records: list[QueryRecord], seed: int) -> list[QueryRecord]:
    allocations = dict(DEFAULT_ALLOCATIONS)
    validate_allocations(records, allocations)
    return sample_records(records, allocations, seed)


def build_qfull(
    queries_path: Path, population_by_qid: dict[str, QueryRecord]
) -> list[QueryRecord]:
    full_records: list[QueryRecord] = []
    missing = []
    for query_id, _query_text in iter_queries(queries_path):
        record = population_by_qid.get(query_id)
        if record is None:
            missing.append(query_id)
            continue
        full_records.append(record)
    if missing:
        raise SliceGenerationError(
            f"qfull source contains query ids missing from qrels/BM25 population; first few: {missing[:5]}"
        )
    return full_records


def build_q300(records: list[QueryRecord], q100_records: list[QueryRecord], seed: int) -> list[QueryRecord]:
    population_counts = Counter(record.stratum for record in records)
    allocations = derive_weighted_allocations(
        total_sample_size=300,
        existing_records=q100_records,
        population_counts=population_counts,
        weights=DEFAULT_ALLOCATIONS,
    )
    existing_counts = Counter(record.stratum for record in q100_records)
    additional_allocations = {
        stratum: allocations[stratum] - existing_counts[stratum] for stratum in allocations
    }
    excluded_ids = {record.query_id for record in q100_records}
    candidate_records = [record for record in records if record.query_id not in excluded_ids]
    validate_allocations(candidate_records, additional_allocations)
    additions = sample_records(candidate_records, additional_allocations, seed)
    combined = {record.query_id: record for record in q100_records}
    for record in additions:
        combined[record.query_id] = record
    return sorted(combined.values(), key=lambda record: int(record.query_id))


def print_stratum_summary(name: str, records: list[QueryRecord]) -> None:
    counts = Counter(record.stratum for record in records)
    print(f"[{name}] {len(records)} queries")
    for stratum in sorted(counts):
        print(f"  {stratum}: {counts[stratum]}")


def main() -> None:
    args = parse_args()
    supported_slices = {"q9", "q50", "q100", "q300", "qfull"}
    requested_slices = []
    for name in args.slices:
        if name not in supported_slices:
            raise SliceGenerationError(f"Unsupported slice: {name}")
        if name not in requested_slices:
            requested_slices.append(name)

    records = build_population(
        queries_path=Path(args.queries),
        qrels_path=Path(args.qrels),
        bm25_run_path=Path(args.bm25_run),
    )
    population_by_qid = {record.query_id: record for record in records}
    output_dir = Path(args.output_dir)

    generated: dict[str, list[QueryRecord]] = {}
    if "q9" in requested_slices:
        generated["q9"] = build_q9(population_by_qid)
    if "q100" in requested_slices or "q300" in requested_slices or "q50" in requested_slices:
        generated["q100"] = build_q100(records, args.seed)
    if "q50" in requested_slices:
        generated["q50"] = build_q50(records, generated["q100"])
    if "q300" in requested_slices:
        generated["q300"] = build_q300(records, generated["q100"], args.seed)
    if "qfull" in requested_slices:
        generated["qfull"] = build_qfull(Path(args.queries), population_by_qid)

    for slice_name in requested_slices:
        slice_records = generated[slice_name]
        output_path = output_dir / f"{slice_name}.tsv"
        write_slice(output_path, slice_records)
        print(f"Wrote {slice_name}: {output_path}")
        print_stratum_summary(slice_name, slice_records)


if __name__ == "__main__":
    main()
