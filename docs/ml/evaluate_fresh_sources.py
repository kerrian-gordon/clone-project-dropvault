"""Evaluate the revised detector on frozen, previously unseen text sources."""

from __future__ import annotations

import csv
import argparse
import hashlib
import json
from pathlib import Path

from content_detector import detect_file


ROOT = Path(__file__).resolve().parents[2]
def main(sample_set: str) -> None:
    manifest_path = ROOT / f"docs/ml/{sample_set}-manifest.json"
    output_path = ROOT / f"docs/ml/{sample_set}-results.json"
    samples = json.loads(manifest_path.read_text(encoding="utf-8"))["samples"]
    source_groups = {
        "fresh-csv": {"seaborn-data", "plotly-datasets"},
        "preamble-csv": {"nasa-giss"},
        "fresh-txt": {"gnu-licenses", "cpython", "nodejs", "golang-go", "rust-lang"},
    }
    expected = source_groups[sample_set]
    count = 3 if sample_set == "preamble-csv" else 5
    if len(samples) != count or {row["source_group"] for row in samples} != expected:
        raise ValueError("The frozen source-separated holdout changed")
    prior_hashes = set()
    for name in ("new-source", "fresh-csv", "preamble-csv", "fresh-txt"):
        if name == sample_set:
            continue
        prior = ROOT / f"docs/ml/{name}-manifest.json"
        if prior.exists():
            prior_hashes.update(
                row["sha256"] for row in json.loads(
                    prior.read_text(encoding="utf-8"))["samples"])
    seen = set()
    results = []
    for sample in samples:
        target = "TXT" if sample_set == "fresh-txt" else "CSV"
        if (sample["format_label"] != target or
                sample["split"] != sample_set.replace("-", "_") + "_holdout"):
            raise ValueError("Unexpected label or split")
        path = (ROOT / sample["relative_path"]).resolve()
        if not path.is_relative_to(ROOT.resolve()) or not path.is_file():
            raise ValueError(f"Missing or outside-repo file: {sample['sample_id']}")
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest().upper()
        if len(raw) != sample["bytes"] or digest != sample["sha256"]:
            raise ValueError(f"Frozen bytes changed: {sample['sample_id']}")
        if digest in prior_hashes or digest in seen:
            raise ValueError(f"Duplicate content: {sample['sample_id']}")
        seen.add(digest)
        try:
            value = path.read_text(encoding="utf-8-sig")
            if target == "TXT":
                structure = "readable_utf8_text" if value.strip() else "needs_review"
            else:
                rows = [row for row in csv.reader(value.splitlines(), strict=True)
                        if row]
                widths = {len(row) for row in rows}
                structure = ("consistent_csv_rows" if len(rows) >= 3 and
                             len(widths) == 1 and next(iter(widths)) >= 2
                             else "needs_review")
        except (UnicodeDecodeError, csv.Error):
            structure = "needs_review"
        detection = detect_file(path)
        results.append({
            "sample_id": sample["sample_id"],
            "source_group": sample["source_group"],
            "expected": target,
            "structural_check": structure,
            "predicted": detection.label,
            "reason": detection.reason,
            "correct": detection.label == target,
        })
    output = {
        "experiment": f"first revised-detector run on {sample_set} sources",
        "sample_count": len(results),
        "correct": sum(row["correct"] for row in results),
        "label_review": "pending human review; structural checks are provisional",
        "results": results,
    }
    output_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", choices=("fresh-csv", "preamble-csv", "fresh-txt"),
                        default="fresh-csv")
    main(parser.parse_args().set)
