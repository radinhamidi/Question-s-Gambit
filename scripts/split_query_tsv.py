#!/usr/bin/env python3
import argparse
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Split a query TSV into N shard TSVs while preserving stable query IDs."
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Path to the input query TSV with query_id<TAB>query lines.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory where shard_XX.tsv files will be written.",
    )
    parser.add_argument(
        "--shards",
        type=int,
        required=True,
        help="Number of output shards.",
    )
    return parser.parse_args()


def load_queries(path: Path) -> list[str]:
    lines: list[str] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            line = raw_line.rstrip("\n")
            if not line:
                continue
            if "\t" not in line:
                raise ValueError(
                    f"Invalid query TSV line {line_no}: expected query_id<TAB>query"
                )
            lines.append(line)
    return lines


def main() -> None:
    args = parse_args()
    if args.shards <= 0:
        raise ValueError("--shards must be a positive integer")

    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    queries = load_queries(input_path)
    if not queries:
        raise ValueError(f"Input query TSV is empty: {input_path}")

    shard_lines: list[list[str]] = [[] for _ in range(args.shards)]
    for index, line in enumerate(queries):
        shard_lines[index % args.shards].append(line)

    for shard_index, lines in enumerate(shard_lines, start=1):
        shard_path = output_dir / f"shard_{shard_index:02d}.tsv"
        with shard_path.open("w", encoding="utf-8") as handle:
            for line in lines:
                handle.write(f"{line}\n")
        print(f"{shard_path}\t{len(lines)}")


if __name__ == "__main__":
    main()
