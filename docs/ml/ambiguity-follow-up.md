# Ambiguous CSV and PDF follow-up

This offline file-format detector now abstains on equal-width, all-text rows when there is no numeric field to support a CSV suggestion. A short all-text CSV can therefore return `UNKNOWN`, as can comma-separated prose. `UNKNOWN` means the prototype is unsure; it does not block an upload.

For PDF, the detector now requires a version header, an end marker, and a `startxref` pointer to a plausible cross-reference table or stream. This rejects the marker-only text probe and an out-of-range pointer. It is still **not a PDF parser or security validator**: a malformed file can contain these structures, and an unusual valid PDF may be missed. The application API was not changed.

## Offline retest

| Check | Result | Qualification |
| --- | ---: | --- |
| [Synthetic stress cases](content-detector-stress-results.json) | 18/18 stated expectations | Five cases were added after the original 11/13 run; expectations are synthetic. |
| [Available original pilot files](content-detector-results.json) | 57/58 labels; 16/16 edge outcomes | One valid text-only CSV now returns `UNKNOWN`. One local presentation is missing and two app files have changed hashes in this worktree; all three were reported and skipped. |
| [Seaborn and Plotly CSV](fresh-csv-results.json) | 5/5 CSV | Previously seen files, reused as regression data. |
| [NASA GISS CSV](preamble-csv-results.json) | 3/3 CSV | Previously seen files, reused as regression data. |
| [License text](fresh-txt-results.json) | 5/5 TXT | Previously seen files, reused as regression data. |
| [Original 20-file new-source batch](new-source-results.json) | 20/20 labels | The batch had already informed the CSV preamble rule; this is a development retest, not a new accuracy estimate. |

The text-only [baseline CSV](file-recognition-baseline.csv) is the one abstention. That tradeoff is intentional until more independently sourced all-text tables and comma-heavy prose are labeled and checked. The original [new-source result](new-source-original-results.json) remains available to distinguish the pre-tuning 18/20 result from the current retest.

The supervised random forest is unchanged. Its original source-separated batch offered only three suggestions out of 20 at the uncalibrated 0.60 cutoff. These results do not justify connecting either detector to uploads or calling the supervised model production-ready.

Run `python docs/ml/stress_content_detector.py` and `python docs/ml/evaluate_content_detector.py --skip-missing --skip-changed` from the repo root. The skip flags report unavailable or changed frozen project samples. Without them, the regression runner fails on a missing or changed file. The source checks need the locally downloaded files whose hashes are recorded in their manifests; those bytes are Git-ignored.
