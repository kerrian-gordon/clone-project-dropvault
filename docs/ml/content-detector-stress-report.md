# Content detector stress check

The [offline stress runner](stress_content_detector.py) initially used 13 small synthetic cases and no private files or network access. The result below was run against the detector after the CSV preamble change and before any further rule changes. The linked [per-case results](content-detector-stress-results.json) now show the current 18-case retest, including non-finite numeric words.

**[11 of 13](content-detector-stress-original-results.json) matched the stated expectation.** The two findings are:

1. Three grammatical sentences with two commas per line were classified as CSV. Consistent column counts alone cannot distinguish this prose from an all-text CSV table. This is a wrong format suggestion, not a failed upload validation check.
2. A text file containing `%PDF-1.7` and `%%EOF` was classified as PDF. Those markers are insufficient to prove the file is parseable PDF. The detector is not a security validator; the current API separately checks file signatures, which also should not be treated as full PDF validation.

The other probes covered a broken ZIP, duplicate ZIP names, a normal ZIP, UTF-16 text, UTF-8 BOM JSON, two-row CSV, quoted multiline CSV, malformed JSON, HTML, and an input just over the detector's 8 MiB limit. The results are synthetic checks, not an accuracy estimate for user uploads.

The [ambiguity follow-up](ambiguity-follow-up.md) records the conservative rules and retest. The original 11/13 result remains the pre-change finding. PDF recognition still needs a real parser if it will ever be used as a validity claim. Keep the current API validation authoritative and the detector offline.

Run `python docs/ml/stress_content_detector.py` from the repo root to reproduce the current 18-case stress check.
