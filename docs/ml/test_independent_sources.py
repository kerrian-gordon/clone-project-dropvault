"""Read-only, small source-separated challenge for the offline pilot.

Uses existing repository files. Does not alter the upload API or train on test files.
Run from the repository root with an environment containing scikit-learn.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from sklearn import __version__ as sklearn_version

from pilot_file_recognition import LABELS, ROOT, features, model, prediction, read_samples


OUTPUT = ROOT / "docs/ml/independent-source-results.json"
CASES = [
    ("presentation", "presentations/DropVault-frontend-backend-live-demo.pptx",
     "PPTX", "project-presentation"),
    ("mock-drive", "apps/web/src/shared/data/mock-drive.json",
     "JSON", "web-fixtures"),
    ("mock-multi-user", "apps/web/src/shared/data/mock-multi-user-drive.json",
     "JSON", "web-fixtures"),
    ("root-package", "package.json", "JSON", "npm-config"),
    ("baseline-table", "docs/ml/file-recognition-baseline.csv",
     "CSV", "baseline-export"),
]


def content_rule(path: Path) -> str | None:
    """A simple independent content baseline for the challenge's three labels."""
    raw = path.read_bytes()
    if raw.startswith(b"PK\x03\x04"):
        try:
            with ZipFile(io.BytesIO(raw)) as archive:
                names = set(archive.namelist())
            if {"[Content_Types].xml", "ppt/presentation.xml"} <= names:
                return "PPTX"
        except BadZipFile:
            pass
    try:
        decoded = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    try:
        parsed = json.loads(decoded)
        if isinstance(parsed, (dict, list)):
            return "JSON"
    except json.JSONDecodeError:
        pass
    try:
        records = list(csv.reader(io.StringIO(decoded)))
        widths = {len(record) for record in records if record}
        if len(records) >= 2 and len(widths) == 1 and next(iter(widths)) >= 2:
            return "CSV"
    except csv.Error:
        pass
    return None


def main() -> None:
    rows = read_samples()
    training = [row for row in rows if row["usage"] == "candidate"
                and row["format_label"] in LABELS]
    training_hashes = {row["sha256"] for row in training}
    classifier = model().fit([features(row["path"]) for row in training],
                             [row["format_label"] for row in training])
    results = []
    for case_id, relative_path, actual, source_group in CASES:
        path = ROOT / relative_path
        if not path.is_file() or path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError(f"Missing or oversized challenge file: {case_id}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest().upper()
        if digest in training_hashes:
            raise ValueError(f"Training bytes leaked into challenge: {case_id}")
        rule_guess = content_rule(path)
        guess = prediction(classifier, features(path))
        results.append({
            "case_id": case_id,
            "relative_path": relative_path,
            "source_group": source_group,
            "sha256": digest,
            "actual": actual,
            "content_rule": rule_guess,
            **guess,
            "suggestion_correct": not guess["abstains_at_0_60"]
            and guess["predicted"] == actual,
        })
    output = {
        "experiment": "small independent-source challenge",
        "sklearn_version": sklearn_version,
        "training_candidates": len(training),
        "test_cases": len(results),
        "raw_correct": sum(case["predicted"] == case["actual"] for case in results),
        "suggestions": sum(not case["abstains_at_0_60"] for case in results),
        "correct_suggestions": sum(case["suggestion_correct"] for case in results),
        "rule_correct": sum(case["content_rule"] == case["actual"] for case in results),
        "limitations": [
            "Only PPTX, JSON, and CSV appear in this challenge",
            "Labels validated structurally but still await human provenance review",
            "Two JSON files share a source group and are not independent observations",
            "The rule baseline recognizes only the three tested formats",
            "The pilot model's scores are not calibrated probabilities",
        ],
        "cases": results,
    }
    OUTPUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
