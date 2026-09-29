"""Evaluate the offline content detector on the pilot and challenge files."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from collections import Counter
from pathlib import Path
from zipfile import ZipFile

from content_detector import detect_bytes, detect_file


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs/ml/content-detector-results.json"


def _samples() -> list[dict[str, str]]:
    with (ROOT / "docs/ml/file-recognition-manifest.csv").open(
        encoding="utf-8", newline=""
    ) as source:
        manifest = list(csv.DictReader(source))
    samples = []
    for row in manifest:
        group = (
            "renamed-smoke" if row["sample_id"].startswith("pilot-renamed-")
            else "separate-source-pptx" if row["sample_id"] == "demo-pptx-001"
            else "out-of-scope" if row["format_label"] == "OUT_OF_SCOPE"
            else "synthetic-known"
        )
        samples.append({
            "sample_id": row["sample_id"],
            "relative_path": row["relative_path"],
            "sha256": row["sha256"],
            "actual": row["format_label"],
            "group": group,
            "source_group": row["source_group"],
        })
    challenge = json.loads(
        (ROOT / "docs/ml/independent-source-results.json").read_text(encoding="utf-8")
    )
    for row in challenge["cases"]:
        samples.append({
            "sample_id": row["case_id"],
            "relative_path": row["relative_path"],
            "sha256": row["sha256"],
            "actual": row["actual"],
            "group": "independent-source",
            "source_group": row["source_group"],
        })
    return samples


def _edge_checks() -> list[dict[str, str]]:
    conflicting = io.BytesIO()
    with ZipFile(conflicting, "w") as archive:
        archive.writestr("word/document.xml", "<document/>")
        archive.writestr("ppt/presentation.xml", "<presentation/>")
    forged_docx = io.BytesIO()
    with ZipFile(forged_docx, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types><Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.'
            'wordprocessingml.document.main+xml"/></Types>',
        )
        archive.writestr("_rels/.rels", "<Relationships/>")
        archive.writestr("word/document.xml", "<wrong-root/>")
    cases = [
        ("empty", b"", "UNKNOWN"),
        ("truncated-pdf", b"%PDF-1.7\n", "UNKNOWN"),
        ("fake-zip", b"PK\x03\x04not-a-zip", "UNKNOWN"),
        ("json-scalar", b"123", "UNKNOWN"),
        ("malformed-json", b'{"unfinished":', "UNKNOWN"),
        ("two-line-prose", b"Hello, world\nGoodbye, world\n", "UNKNOWN"),
        ("csv-with-preamble", b"Export generated for a sample\nFields follow below\n"
         b"day,amount,count\n2025-01-01,12.5,3\n2025-01-02,14.0,2\n", "CSV"),
        ("semicolon-table-with-preamble", b"Report data\n"
         b"day;amount;count\n2025-01-01;12.5;3\n2025-01-02;14.0;2\n", "CSV"),
        ("prose-with-commas", b"A small note about figures\n"
         b"Hello, world, again\nToday, we, meet\nTomorrow, we, leave\n", "TXT"),
        ("mixed-width-table-after-preamble", b"Export data\n"
         b"day,amount,count\n2025-01-01,12.5,3\n2025-01-02,14.0\n", "TXT"),
        ("long-preamble-before-table", b"Report note\n" * 33 +
         b"day,amount,count\n2025-01-01,12.5,3\n2025-01-02,14.0,2\n", "TXT"),
        ("malformed-xml", b"<broken", "UNKNOWN"),
        ("unknown-binary", b"\x00\xff\x01\xfe", "UNKNOWN"),
        ("conflicting-office-parts", conflicting.getvalue(), "UNKNOWN"),
        ("forged-office-main-part", forged_docx.getvalue(), "UNKNOWN"),
        ("clear-text", b"Project note: check the sample\n", "TXT"),
    ]
    results = []
    for name, raw, expected in cases:
        detection = detect_bytes(raw)
        results.append({
            "case": name,
            "expected": expected,
            "predicted": detection.label,
            "reason": detection.reason,
            "passed": detection.label == expected,
        })
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-missing", action="store_true",
                        help="Report missing optional local samples instead of failing")
    parser.add_argument("--skip-changed", action="store_true",
                        help="Report changed project files instead of treating them as the frozen sample")
    args = parser.parse_args()
    samples = _samples()
    seen_ids = set()
    results = []
    missing = []
    changed = []
    for row in samples:
        if row["sample_id"] in seen_ids:
            raise ValueError(f"Duplicate sample ID: {row['sample_id']}")
        seen_ids.add(row["sample_id"])
        path = (ROOT / row["relative_path"]).resolve()
        if not path.is_relative_to(ROOT.resolve()):
            raise ValueError(f"Outside-repo sample: {row['sample_id']}")
        if not path.is_file():
            if args.skip_missing:
                missing.append(row["sample_id"])
                continue
            raise ValueError(f"Missing or outside-repo sample: {row['sample_id']}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest().upper()
        if digest != row["sha256"]:
            if args.skip_changed:
                changed.append(row["sample_id"])
                continue
            raise ValueError(f"Sample hash changed: {row['sample_id']}")
        detection = detect_file(path)
        results.append({
            "sample_id": row["sample_id"],
            "group": row["group"],
            "source_group": row["source_group"],
            "actual": row["actual"],
            "predicted": detection.label,
            "reason": detection.reason,
            "correct": detection.label == row["actual"],
        })
    edges = _edge_checks()
    if any(not row["passed"] for row in edges):
        raise AssertionError("An edge check failed")
    summary = []
    for group in sorted({row["group"] for row in results}):
        subset = [row for row in results if row["group"] == group]
        summary.append({
            "group": group,
            "total": len(subset),
            "correct": sum(row["correct"] for row in subset),
            "unknown": sum(row["predicted"] == "UNKNOWN" for row in subset),
            "incorrect_label": sum(
                not row["correct"] and row["predicted"] != "UNKNOWN"
                for row in subset
            ),
            "predicted_counts": dict(Counter(row["predicted"] for row in subset)),
        })
    output = {
        "experiment": "offline content detector prototype",
        "sample_count": len(results),
        "missing_samples": missing,
        "changed_samples": changed,
        "edge_checks": len(edges),
        "limits": [
            "sample labels and provenance await human review",
            "synthetic known samples come from one source group per format",
            "large files and ambiguous or malformed data may return UNKNOWN",
            "this prototype is not an upload security validator",
        ],
        "summary": summary,
        "results": results,
        "edge_results": edges,
    }
    OUTPUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "sample_count": len(results),
        "missing_samples": missing,
        "changed_samples": changed,
        "summary": summary,
        "edge_checks_passed": sum(row["passed"] for row in edges),
        "edge_checks_total": len(edges),
        "results": str(OUTPUT),
    }, indent=2))


if __name__ == "__main__":
    main()
