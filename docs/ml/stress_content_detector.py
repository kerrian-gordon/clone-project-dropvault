"""Small, offline adversarial probes for the format-suggestion prototype.

This records failures as findings. It does not modify detector rules or use
private files, network access, or filenames as classification hints.
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path
from zipfile import ZipFile

from content_detector import MAX_INPUT_BYTES, detect_bytes


OUTPUT = Path(__file__).with_name("content-detector-stress-results.json")


def archive(entries: list[tuple[str, bytes]]) -> bytes:
    buffer = io.BytesIO()
    with ZipFile(buffer, "w") as zipped:
        for name, contents in entries:
            zipped.writestr(name, contents)
    return buffer.getvalue()


def main() -> None:
    cases = [
        ("comma-prose-three-lines",
         b"Dear team, here are notes, please read\n"
         b"On Monday, we met, at noon\n"
         b"On Tuesday, we left, at six\n", "UNKNOWN",
         "Equal-width prose is ambiguous with an all-text table"),
        ("comma-prose-with-title",
         b"Meeting notes\n"
         b"Dear team, here are notes, please read\n"
         b"On Monday, we met, at noon\n"
         b"On Tuesday, we left, at six\n", "TXT",
         "A title should not turn prose into CSV"),
        ("fake-pdf-envelope", b"%PDF-1.7\nThis is only text.\n%%EOF\n", "UNKNOWN",
         "PDF markers alone do not establish a valid PDF"),
        ("fake-pdf-offset", b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"
         b"startxref\n9999\n%%EOF\n", "UNKNOWN",
         "A cross-reference pointer outside the file is implausible"),
        ("truncated-zip", b"PK\x03\x04abc", "UNKNOWN", "Broken ZIP container"),
        ("duplicate-zip-names", archive([
            ("same.txt", b"first"), ("same.txt", b"second")]), "UNKNOWN",
         "Duplicate archive paths are ambiguous"),
        ("plain-zip", archive([("note.txt", b"hello")]), "ZIP",
         "A valid ordinary archive"),
        ("utf16-text", "A simple note in UTF-16".encode("utf-16"), "UNKNOWN",
         "UTF-16 is intentionally outside the UTF-8 text parser"),
        ("bom-json", b"\xef\xbb\xbf{\"a\": 1}", "JSON",
         "UTF-8 BOM before a JSON object"),
        ("two-row-csv", b"name,age\nAda,36\n", "UNKNOWN",
         "Two rows remain ambiguous"),
        ("all-text-csv", b"name,city,role\nAda,London,engineer\n"
         b"Grace,New York,scientist\n", "UNKNOWN",
         "A small all-text table remains ambiguous without other evidence"),
        ("numeric-csv", b"name,age,city\nAda,36,London\n"
         b"Grace,85,New York\n", "CSV",
         "Multiple rows with numeric data support CSV"),
        ("nonfinite-words-csv", b"name,color,tag\nInfinity,#abc,x\n"
         b"NaN,#def,y\n", "UNKNOWN",
         "Color names and non-finite words are not numeric table evidence"),
        ("nonfinite-words-preamble", b"Color catalog\n"
         b"name,color,tag\nInfinity,#abc,x\nNaN,#def,y\n", "TXT",
         "Non-finite words do not satisfy preamble-table numeric evidence"),
        ("quoted-multiline-csv", b"name,age,city\n"
         b'"Ada\nLovelace",36,London\n"Grace Hopper",85,New York\n', "CSV",
         "Quoted newlines are valid CSV fields"),
        ("broken-json", b"{\"a\":", "UNKNOWN", "Incomplete JSON"),
        ("html-document", b"<!doctype html><html><body>x</body></html>",
         "OUT_OF_SCOPE", "Recognizable HTML"),
        ("input-over-limit", b"A" * (MAX_INPUT_BYTES + 1), "UNKNOWN",
         "The detector must reject oversized inputs before parsing"),
    ]
    results = []
    for name, raw, expected, rationale in cases:
        start = time.perf_counter()
        detected = detect_bytes(raw)
        results.append({
            "case": name,
            "bytes": len(raw),
            "expected": expected,
            "predicted": detected.label,
            "reason": detected.reason,
            "matches_expectation": detected.label == expected,
            "rationale": rationale,
            "elapsed_ms": round((time.perf_counter() - start) * 1000, 2),
        })
    output = {
        "purpose": "local adversarial check; synthetic expectations require review",
        "sample_count": len(results),
        "matches_expectation": sum(row["matches_expectation"] for row in results),
        "results": results,
    }
    OUTPUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "sample_count": len(results),
        "matches_expectation": output["matches_expectation"],
        "findings": [row for row in results if not row["matches_expectation"]],
        "output": str(OUTPUT),
    }, indent=2))


if __name__ == "__main__":
    main()
