"""Score the frozen second-source set once, without changing detector rules."""

from __future__ import annotations

import csv
import hashlib
import io
import json
from collections import Counter
from pathlib import Path

from content_detector import detect_bytes


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "docs/ml/holdout-v2-manifest.json"
OUTPUT = ROOT / "docs/ml/holdout-v2-results.json"


def structural_note(raw: bytes, expected: str) -> str:
    if expected == "CSV":
        try:
            rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig")), strict=True))
        except (UnicodeDecodeError, csv.Error):
            return "csv_parse_failed"
        widths = {len(row) for row in rows if row}
        return "consistent_csv_rows" if len(rows) >= 3 and len(widths) == 1 and min(widths) >= 2 else "csv_needs_review"
    if expected == "TXT":
        try:
            raw.decode("utf-8-sig")
            return "readable_utf8_text"
        except UnicodeDecodeError:
            return "text_encoding_needs_review"
    if raw.startswith(b"%PDF-"):
        return "pdf_signature_present; validity_not_independently_checked"
    return "pdf_signature_absent"


def main() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rows = manifest["samples"]
    if len(rows) != 9:
        raise ValueError("Expected the nine preselected samples")
    seen_ids, seen_hashes = set(), set()
    results = []
    for row in rows:
        if row["sample_id"] in seen_ids:
            raise ValueError(f"Repeated ID: {row['sample_id']}")
        seen_ids.add(row["sample_id"])
        path = (ROOT / row["relative_path"]).resolve()
        if not path.is_relative_to(ROOT.resolve()) or not path.is_file():
            raise ValueError(f"Missing or outside-repo sample: {row['sample_id']}")
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest().upper()
        if len(raw) != row["bytes"] or digest != row["sha256"]:
            raise ValueError(f"Frozen bytes changed: {row['sample_id']}")
        if digest in seen_hashes:
            raise ValueError(f"Duplicate file bytes: {row['sample_id']}")
        seen_hashes.add(digest)
        detected = detect_bytes(raw)
        expected = row["expected"]
        results.append({
            "sample_id": row["sample_id"],
            "source_group": row["source_group"],
            "condition": row["condition"],
            "expected": expected,
            "predicted": detected.label,
            "reason": detected.reason,
            "matches_expectation": detected.label == expected,
            "abstained": detected.label == "UNKNOWN" and expected != "UNKNOWN",
            "wrong_suggestion": detected.label not in (expected, "UNKNOWN"),
            "structural_note": structural_note(raw, expected),
            "review_status": row["review_status"],
        })
    summary = {
        "sample_count": len(results),
        "matches_expectation": sum(row["matches_expectation"] for row in results),
        "abstentions_on_valid_files": sum(row["abstained"] for row in results),
        "wrong_suggestions": sum(row["wrong_suggestion"] for row in results),
        "by_expected": dict(Counter(row["expected"] for row in results)),
    }
    output = {
        "experiment": "detector evaluation on frozen second source-separated set",
        "label_review": manifest["label_status"],
        "limitations": [
            "PDF labels rely on the providers' descriptions; no independent PDF parser was available",
            "CSV and TXT structural notes are basic checks, not human label review",
            "nine files and clustered PDF sources cannot estimate deployment accuracy",
        ],
        "summary": summary,
        "results": results,
    }
    OUTPUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"summary": summary, "results": str(OUTPUT)}, indent=2))


if __name__ == "__main__":
    main()
