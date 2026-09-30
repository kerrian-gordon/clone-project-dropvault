# Frozen new-source file recognition check

This first source-separated challenge has **20 files: five each for PPTX, JSON, CSV, and TXT, from two source groups per format**. The files were not used to train the random forest or write the content detector's initial rules. The [download plan](new-source-plan.json) records their URLs, and the [frozen manifest](new-source-manifest.json) records SHA-256 hashes, labels, source groups, and local paths. Downloaded bytes live in a Git-ignored directory. Labels are provisional and still need human review.

The local run used Python 3.14.4 and scikit-learn 1.9.1 for the random forest. Apache Tika Server 3.3.2 was downloaded from Apache, verified against its SHA-512 checksum, and run only on localhost.

Sources: [Apache POI](https://github.com/apache/poi), [Open XML SDK](https://github.com/dotnet/Open-XML-SDK), [JSON Schema Test Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite), [USGS earthquake API](https://earthquake.usgs.gov/fdsnws/event/1/), [NASA POWER API](https://power.larc.nasa.gov/docs/services/api/temporal/daily/), [Project Gutenberg](https://www.gutenberg.org/), and [RFC Editor](https://www.rfc-editor.org/). A source group identifies the provider or repository; it does not prove that every file in the group was made by the same application. No private uploads were used. External files remain local for evaluation and should not be added to Git without a separate rights review.

## Results without changing either prototype

| Format | Files | Content detector | Random forest raw | Forest suggestions at 0.60 | Tika bytes only | Tika with filename |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| PPTX | 5 | 5 | 5 | 0 | 5 | 5 |
| JSON | 5 | 5 | 5 | 3 correct | 0 | 5 |
| CSV | 5 | 3 | 1 | 0 | 0 | 5 |
| TXT | 5 | 5 | 4 | 0 | 5 | 5 |
| **Total** | **20** | **18** | **15** | **3 correct of 3 offered** | **10** | **20** |

The [original content detector results](new-source-original-results.json) show both wrong labels: NASA POWER's CSV responses begin with a human-readable header before the comma-separated table, so the detector called both TXT. [NASA documents CSV as an output format](https://power.larc.nasa.gov/docs/services/api/temporal/daily/); the downloaded files visibly contain a CSV table after `-END HEADER-`. The random forest offered no suggestion for any PPTX, CSV, or TXT file at its uncalibrated 0.60 cutoff. It made three correct JSON suggestions.

[Tika's per-file results](new-source-tika-results.json) show it returned plain text for all JSON and CSV files when given only bytes. With filename hints it got all 20, but that is a different input condition from the filename-free detector and model. This batch contains no renamed files; the earlier [Tika benchmark](tika-benchmark.md) shows why filename hints cannot be treated as ground truth.

## What the result means

This is a useful failure case, not a release accuracy estimate. The source groups are still small, sample labels await human review, and four pilot formats were not expanded in this batch. The detector rules were written before these 20 files were evaluated; now that the NASA failure is known, this batch must remain a **development reference** if we change the rules. A later, unseen holdout is needed to measure an improved detector fairly.

The immediate improvement candidate is explicit recognition of a bounded text preamble followed by a consistent CSV table, while avoiding false positives on prose. Develop that against separate examples, then test on a fresh source group. Keep `UNKNOWN` available for ambiguous cases. The upload API remains unchanged.

That work is recorded in the [CSV preamble follow-up](csv-preamble-report.md). This page preserves the **original** detector score from before the rule changed. The current [development retest](new-source-results.json) is 20/20 after the rules were adjusted using known failures; it is not a fresh holdout result.

## Reproduce locally

Run `powershell -NoProfile -ExecutionPolicy Bypass -File docs/ml/fetch_new_sources.ps1` from the repository root. Once the manifest exists, this command verifies its hashes and refuses changed files; it does not silently replace the frozen set. With scikit-learn installed, run `python docs/ml/evaluate_new_sources.py`. To repeat the Tika comparison, start Tika Server 3.3.2 on `127.0.0.1:9998` and run `powershell -NoProfile -ExecutionPolicy Bypass -File docs/ml/test_tika_new_sources.ps1`. The Tika server is stopped after this run.
