"""Evaluate frozen new-source files without using them for training or tuning."""

from __future__ import annotations

import csv
import hashlib
import json
from collections import Counter
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from content_detector import detect_file
from pilot_file_recognition import LABELS, features, model, read_samples, prediction


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "docs/ml/new-source-manifest.json"
OUTPUT = ROOT / "docs/ml/new-source-results.json"
TARGET_LABELS = ("PPTX", "JSON", "CSV", "TXT")


def _sanity_check_label(path: Path, label: str) -> str:
    """Check basic structure independently of the detector's full rules."""
    if label == "PPTX":
        try:
            with ZipFile(path) as archive:
                names = set(archive.namelist())
                if {"[Content_Types].xml", "ppt/presentation.xml"} <= names:
                    return "office_zip_parts_present"
        except BadZipFile:
            pass
        return "needs_review"
    if label == "JSON":
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
            return "json_parsed" if isinstance(value, (dict, list)) else "needs_review"
        except (UnicodeDecodeError, json.JSONDecodeError):
            return "needs_review"
    if label == "CSV":
        try:
            text = path.read_text(encoding="utf-8-sig")
            rows = list(csv.reader(text.splitlines()))
            return "readable_csv_export" if rows else "needs_review"
        except (UnicodeDecodeError, csv.Error):
            return "needs_review"
    if label == "TXT":
        try:
            path.read_text(encoding="utf-8-sig")
            return "readable_utf8_text"
        except UnicodeDecodeError:
            return "needs_review"
    return "needs_review"


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rows = manifest["samples"]
    counts = Counter(row["format_label"] for row in rows)
    if counts != Counter({label: 5 for label in TARGET_LABELS}):
        raise ValueError(f"Expected five new files per target label: {counts}")
    if any(row["split"] != "new_source_holdout" for row in rows):
        raise ValueError("New files must remain in the holdout split")
    old = read_samples()
    old_hashes = {row["sha256"] for row in old}
    training = [row for row in old if row["usage"] == "candidate"
                and row["format_label"] in LABELS]
    classifier = model().fit(
        [features(row["path"]) for row in training],
        [row["format_label"] for row in training],
    )
    seen_hashes = set()
    results = []
    for row in rows:
        path = (ROOT / row["relative_path"]).resolve()
        if not path.is_relative_to(ROOT.resolve()) or not path.is_file():
            raise ValueError(f"Missing or outside-repo file: {row['sample_id']}")
        if path.stat().st_size != row["bytes"]:
            raise ValueError(f"File size changed: {row['sample_id']}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest().upper()
        if digest != row["sha256"]:
            raise ValueError(f"File hash changed: {row['sample_id']}")
        if digest in old_hashes or digest in seen_hashes:
            raise ValueError(f"Repeated old or new content: {row['sample_id']}")
        seen_hashes.add(digest)
        detector = detect_file(path)
        forest = prediction(classifier, features(path))
        results.append({
            "sample_id": row["sample_id"],
            "actual": row["format_label"],
            "source_group": row["source_group"],
            "label_check": _sanity_check_label(path, row["format_label"]),
            "content_label": detector.label,
            "content_reason": detector.reason,
            "content_correct": detector.label == row["format_label"],
            "model_label": forest["predicted"],
            "model_score": forest["score"],
            "model_abstains": forest["abstains_at_0_60"],
            "model_raw_correct": forest["predicted"] == row["format_label"],
        })
    summary = []
    for label in TARGET_LABELS:
        subset = [row for row in results if row["actual"] == label]
        summary.append({
            "label": label,
            "total": len(subset),
            "sources": len({row["source_group"] for row in subset}),
            "content_correct": sum(row["content_correct"] for row in subset),
            "content_unknown": sum(row["content_label"] == "UNKNOWN" for row in subset),
            "content_wrong": sum(
                not row["content_correct"] and row["content_label"] != "UNKNOWN"
                for row in subset
            ),
            "model_raw_correct": sum(row["model_raw_correct"] for row in subset),
            "model_suggestions": sum(not row["model_abstains"] for row in subset),
            "model_correct_suggestions": sum(
                not row["model_abstains"] and row["model_raw_correct"]
                for row in subset
            ),
        })
    output = {
        "experiment": "frozen new-source holdout",
        "sample_count": len(results),
        "training_count": len(training),
        "label_review": "pending human review; structural checks are provisional",
        "summary": summary,
        "results": results,
    }
    OUTPUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"summary": summary, "results": str(OUTPUT)}, indent=2))


if __name__ == "__main__":
    main()
