# Offline content detector prototype

The [detector](content_detector.py) uses Python's standard library and reads file bytes, never the filename or browser MIME type. It checks PDF markers, ZIP and Office package structure, known out-of-scope signatures, then parses UTF-8 text as JSON, CSV, or plain text. It returns `UNKNOWN` for unreadable, malformed, oversized, or ambiguous content. Its result is a **format suggestion**, not an upload security verdict.

The [evaluation runner](evaluate_content_detector.py) checks file hashes and writes [per-file results](content-detector-results.json). It also tests empty or malformed samples and a forged Office ZIP. No application routes or storage behavior changed. The [ambiguity follow-up](ambiguity-follow-up.md) records the latest rule change and retest.

## Local results

| Set | Files | Correct | Unknown | Wrong label |
| --- | ---: | ---: | ---: | ---: |
| Synthetic known formats | 40 | 40 | 0 | 0 |
| Available separate-source project files | 2 | 1 | 1 | 0 |
| Renamed smoke probes | 3 | 3 | 0 | 0 |
| Separate demo PPTX | 1 | 1 | 0 | 0 |
| Out-of-scope formats | 12 | 12 | 0 | 0 |
| Malformed, ambiguous, and preamble checks | 16 | 16 expected outcomes | - | - |

The table reflects the current worktree's 58 available, hash-matching pilot files. The missing presentation and two changed project files were reported and skipped. The one `UNKNOWN` is an all-text CSV; the [earlier 61/61 result](content-detector-original-results.json) was measured before the ambiguity rule changed.

The detector identified the PDF, DOCX, and JSON files with deliberately misleading extensions. It also returned `UNKNOWN` for a truncated PDF, fake ZIP, malformed JSON and XML, ambiguous two-line text, conflicting Office parts, and a forged Office main part.

For comparison, the [Tika benchmark](tika-benchmark.md) identified 30/40 synthetic known formats and 1/5 separate-source files **without** filename hints. With filename hints it identified 40/40 and 5/5, but missed the renamed JSON probe in both modes. The [supervised pilot](independent-source-report.md) made 3/5 correct raw guesses on the separate-source files and abstained on two. These methods were tested on the same local files, but the model was trained on the synthetic candidates; this is not a deployment-quality head-to-head benchmark.

## Limits

The 40 known-format samples come from one generator per class, and all labels still await human review. The separate-source check covers only PPTX, JSON, and CSV. The detector's rules were written with knowledge of this pilot's target classes, so the pilot counts are **sanity checks**, not estimates of performance on arbitrary uploads.

TXT is a fallback for readable, unstructured UTF-8; an unfamiliar text-based format could be mislabeled TXT. Two-line CSV returns `UNKNOWN` because it can resemble prose. Large files (over 8 MiB), uncommon encodings, encrypted archives, and unusual valid PDFs may also return `UNKNOWN`. ZIP checks inspect bounded structure and selected XML parts; they do not validate every archive member or protect an upload pipeline from malicious files. The API's existing validation remains authoritative.

## Next test

Collect reviewed files made by different applications for **every** format, plus damaged and misleading examples. Hold each source group out of development, then evaluate wrong labels and `UNKNOWN` results separately. Decide whether ML adds value only after that broader test.

From the repo root, run `python docs/ml/evaluate_content_detector.py --skip-missing --skip-changed` when the presentation is unavailable or project files have changed. The runner reports each skipped frozen sample. Omit those flags to require every original file and hash.

A [frozen 20-file new-source check](new-source-report.md) found a concrete limitation: two NASA CSV exports with text preambles were labeled TXT. The subsequent [CSV preamble follow-up](csv-preamble-report.md) documents the rule change and new source checks; the original 20-file score remains the baseline.
