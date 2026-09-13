#!/usr/bin/env python3
import argparse
import shutil
from pathlib import Path

ARTIFACT_PATTERNS = [
    "*.json",
    "raw-events/*.jsonl",
    "stderr/*.log",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge benchmark shard outputs into one canonical run directory."
    )
    parser.add_argument(
        "--source-root",
        required=True,
        help="Directory containing shard_* benchmark output directories.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Destination directory for the merged benchmark artifacts.",
    )
    return parser.parse_args()


def collect_shard_dirs(source_root: Path) -> list[Path]:
    shard_dirs = sorted(
        path
        for path in source_root.iterdir()
        if path.is_dir() and path.name.startswith("shard_")
    )
    if not shard_dirs:
        raise ValueError(f"No shard directories found under {source_root}")
    return shard_dirs


def copy_unique_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        if src.read_bytes() != dst.read_bytes():
            raise ValueError(f"Conflicting artifact for {dst}")
        return
    shutil.copy2(src, dst)


def main() -> None:
    args = parse_args()
    source_root = Path(args.source_root)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    shard_dirs = collect_shard_dirs(source_root)
    copied = 0
    for shard_dir in shard_dirs:
        for pattern in ARTIFACT_PATTERNS:
            for src in sorted(shard_dir.glob(pattern)):
                relative = src.relative_to(shard_dir)
                copy_unique_file(src, output_dir / relative)
                copied += 1

    print(f"Merged {len(shard_dirs)} shard directories into {output_dir}")
    print(f"Copied or verified {copied} artifacts")


if __name__ == "__main__":
    main()
