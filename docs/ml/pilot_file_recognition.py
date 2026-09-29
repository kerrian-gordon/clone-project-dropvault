"""Offline supervised file-format pilot. Never called by the Dropvault API.

Install the packages in pilot-requirements.txt, then run this file from the repo root.
The output is an exploratory report; current samples have pending human review and
only one source group per named format.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
from collections import Counter
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from sklearn import __version__ as sklearn_version
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import StratifiedKFold


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "docs/ml/file-recognition-manifest.csv"
RESULTS = ROOT / "docs/ml/pilot-results.json"
LABELS = ["PDF", "DOCX", "PPTX", "XLSX", "JSON", "CSV", "TXT", "ZIP"]
THRESHOLD = 0.60  # Exploratory abstention rule, set before reading results.
SEED = 7
MAX_SAMPLE_BYTES = 2 * 1024 * 1024


def read_samples():
    with MANIFEST.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))
    seen = set()
    for row in rows:
        if row["sample_id"] in seen:
            raise ValueError(f"Duplicate sample ID: {row['sample_id']}")
        seen.add(row["sample_id"])
        path = ROOT / row["relative_path"]
        if not path.is_file() or path.stat().st_size > MAX_SAMPLE_BYTES:
            raise ValueError(f"Missing or oversized sample: {row['sample_id']}")
        if hashlib.sha256(path.read_bytes()).hexdigest().upper() != row["sha256"]:
            raise ValueError(f"Sample hash changed: {row['sample_id']}")
        row["path"] = path
    return rows


def features(path):
    raw = path.read_bytes()
    sample = raw[:65536]
    histogram = [0] * 16
    for byte in sample:
        histogram[byte // 16] += 1
    scale = max(1, len(sample))
    values = [math.log1p(len(raw))]
    values.extend((raw[index] / 255) if index < len(raw) else -1 for index in range(16))
    values.extend((raw[-index] / 255) if index <= len(raw) else -1 for index in range(1, 9))
    values.extend(count / scale for count in histogram)
    values.extend([
        sum(byte in (9, 10, 13) or 32 <= byte <= 126 for byte in sample) / scale,
        sample.count(0) / scale,
        sample.count(10) / scale,
        sum(byte >= 128 for byte in sample) / scale,
        int(raw.startswith(b"%PDF-")),
        int(raw.startswith(b"PK\x03\x04")),
    ])
    try:
        with ZipFile(path) as archive:
            names = set(archive.namelist())
    except (BadZipFile, ValueError):
        names = set()
    values.extend([
        int("[Content_Types].xml" in names),
        int("word/document.xml" in names),
        int("ppt/presentation.xml" in names),
        int("xl/workbook.xml" in names),
        min(len(names), 100) / 100,
    ])
    try:
        decoded = raw.decode("utf-8-sig")
        is_text = 1
    except UnicodeDecodeError:
        decoded = ""
        is_text = 0
    try:
        parsed = json.loads(decoded)
        is_json = int(isinstance(parsed, (dict, list)))
    except (json.JSONDecodeError, ValueError):
        is_json = 0
    try:
        records = list(csv.reader(io.StringIO(decoded))) if is_text else []
        widths = {len(record) for record in records if record}
        is_csv = int(len(records) >= 2 and len(widths) == 1 and next(iter(widths)) >= 2)
    except csv.Error:
        is_csv = 0
    values.extend([is_text, is_json, is_csv])
    return values


def model():
    return RandomForestClassifier(n_estimators=100, max_depth=8,
                                  random_state=SEED, n_jobs=1)


def prediction(classifier, vector):
    probabilities = classifier.predict_proba([vector])[0]
    winner = int(probabilities.argmax())
    return {"predicted": str(classifier.classes_[winner]),
            "score": round(float(probabilities[winner]), 4),
            "abstains_at_0_60": bool(probabilities[winner] < THRESHOLD)}


def main():
    rows = read_samples()
    known = [row for row in rows if row["usage"] == "candidate"
             and row["format_label"] in LABELS]
    unknown = [row for row in rows if row["format_label"] == "OUT_OF_SCOPE"]
    renamed = [row for row in rows if row["sample_id"].startswith("pilot-renamed-")]
    external = [row for row in rows if row["sample_id"] == "demo-pptx-001"]
    if Counter(row["format_label"] for row in known) != Counter({label: 5 for label in LABELS}):
        raise ValueError("Pilot expects five candidate files per named label")
    vectors = {row["sample_id"]: features(row["path"]) for row in rows}
    x = [vectors[row["sample_id"]] for row in known]
    y = [row["format_label"] for row in known]
    folds = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    cv = []
    for train_indices, test_indices in folds.split(x, y):
        classifier = model().fit([x[index] for index in train_indices],
                                 [y[index] for index in train_indices])
        for index in test_indices:
            cv.append({"sample_id": known[index]["sample_id"],
                       "actual": y[index], **prediction(classifier, x[index])})
    cv.sort(key=lambda item: item["sample_id"])
    actual = [item["actual"] for item in cv]
    predicted = [item["predicted"] for item in cv]

    final_model = model().fit(x, y)
    unknown_results = [{"sample_id": row["sample_id"],
                        **prediction(final_model, vectors[row["sample_id"]])}
                       for row in unknown]
    external_results = [{"sample_id": row["sample_id"],
                         "actual": row["format_label"],
                         **prediction(final_model, vectors[row["sample_id"]])}
                        for row in external]
    renamed_results = []
    for row in renamed:
        training = [item for item in known if item["family_id"] != row["family_id"]]
        classifier = model().fit([vectors[item["sample_id"]] for item in training],
                                 [item["format_label"] for item in training])
        renamed_results.append({"sample_id": row["sample_id"],
                                "actual": row["format_label"],
                                "excluded_family": row["family_id"],
                                **prediction(classifier, vectors[row["sample_id"]])})

    result = {
        "experiment": "local format recognition pilot",
        "sklearn_version": sklearn_version,
        "seed": SEED,
        "threshold": THRESHOLD,
        "training_labels": LABELS,
        "training_candidates": len(known),
        "limits": ["pending human label review", "one source group per named format",
                   "no independent multi-source held-out set", "scores are not calibrated",
                   "out-of-scope formats were not used for training"],
        "cross_validation": {
            "accuracy": round(accuracy_score(actual, predicted), 4),
            "classification_report": classification_report(actual, predicted,
                                                        labels=LABELS, output_dict=True,
                                                        zero_division=0),
            "confusion_matrix": confusion_matrix(actual, predicted,
                                                 labels=LABELS).tolist(),
            "predictions": cv,
        },
        "out_of_scope_challenge": unknown_results,
        "renamed_family_held_out": renamed_results,
        "separate_source_pptx": external_results,
    }
    RESULTS.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "cross_validation_accuracy": result["cross_validation"]["accuracy"],
        "out_of_scope_abstained": sum(item["abstains_at_0_60"] for item in unknown_results),
        "out_of_scope_total": len(unknown_results),
        "renamed": renamed_results,
        "separate_source_pptx": external_results,
        "results": str(RESULTS),
    }, indent=2))


if __name__ == "__main__":
    main()
