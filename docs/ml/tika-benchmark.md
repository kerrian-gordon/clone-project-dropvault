# Local Apache Tika comparison

This compares the offline file-recognition pilot with Apache Tika Server 3.3.2. Tika ran on `127.0.0.1:9998`, so the test files were sent only to the local server. The runnable jar came from the [Apache Tika download page](https://tika.apache.org/download) and its downloaded SHA-512 checksum matched. The [runner](test_tika.ps1) verifies each sample's SHA-256 before sending it; [per-file results](tika-results.json) retain the MIME response and mapped pilot label.

Tika received each file twice: once as bytes with no filename hint, and once with a `Content-Disposition` filename. The [Tika server documentation](https://cwiki.apache.org/confluence/spaces/TIKA/pages/148639291/TikaServer) says a filename can improve detection, particularly for CSV. These are two distinct benchmarks; the ML pilot receives no filename feature.

## Results

| Set | Files | Tika, bytes only | Tika, filename hint |
| --- | ---: | ---: | ---: |
| Synthetic known formats | 40 | 30 correct | 40 correct |
| Five separate-source project files | 5 | 1 correct | 5 correct |
| Renamed smoke probes | 3 | 2 correct | 2 correct |
| Separate demo PPTX | 1 | 1 correct | 1 correct |
| Out-of-scope formats | 12 | 11 correct | 12 correct |

For the five separate-source files, the **ML pilot** made 3/5 correct raw guesses and 3/5 usable suggestions, all correct. Tika identified only the PPTX from bytes alone; it returned `text/plain` for all three JSON files and the CSV. With filename hints, it identified all five. The small custom content rule in the [separate-source check](independent-source-report.md) also identified all five, but it only implements the three formats used in that check. None of these five-file figures establishes general accuracy.

Tika recognized the renamed PDF and DOCX from content in both modes. It called the JSON renamed `.txt` `text/plain` in both modes. With no filename, it also called the out-of-scope XML sample `text/plain`. The runner maps unrecognized MIME types to `OUT_OF_SCOPE`; that is a mapping for these pilot labels, not a claim that Tika explicitly returned an out-of-scope verdict.

## Decision

Tika is a useful local comparison tool, especially for PDFs and Office containers. It does not settle the JSON/CSV/TXT boundary without filename information, and filename hints can be misleading. A practical next experiment is a combined detector: use Tika for binary/container formats, then parse text as JSON or CSV before falling back to TXT. Compare that detector and the ML model on larger, human-reviewed, source-separated files before integrating either into uploads. The API's validation rules remain the upload authority.

The [offline content detector prototype](content-detector-report.md) now tests that approach without running Tika. Its original 61/61 result came from a small, partly synthetic set before later ambiguity changes; see the current detector report for the retest.

To rerun, start Tika Server locally and run `powershell -NoProfile -ExecutionPolicy Bypass -File docs/ml/test_tika.ps1` from the repository root. The test script rejects non-local HTTP addresses. The separate-source presentation currently lives in untracked `presentations/`, so another checkout needs that file for a full reproduction. No Tika jar or file contents are stored in this report.
