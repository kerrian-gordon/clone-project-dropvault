# CSV preamble detector follow-up

The [content detector](content_detector.py) now recognizes a CSV table after a short, single-field text preamble. It checks at most 32 preamble lines, 4 KiB of preamble text, and 256 KiB for this secondary table scan. The table must have at least three columns, a distinct text header, consistent row widths, and numeric values in the first two data rows. These conservative rules still return TXT or UNKNOWN for some valid CSV files; the result is a format suggestion, not an upload security check.

## Checks run

| Set | Role | Result |
| --- | --- | --- |
| Original local pilot at the time of this change | Regression check | 61/61 expected labels; 16/16 edge outcomes |
| [Seaborn and Plotly CSV](fresh-csv-results.json) | New providers, ordinary tables | 5/5 CSV |
| [NASA GISS CSV](preamble-csv-results.json) | Untouched preamble examples | 3/3 CSV via the new rule |
| [Plain-text licenses](fresh-txt-results.json) | New negative sources | 5/5 TXT; no CSV false positives |
| NASA POWER CSV from the [first new-source batch](new-source-report.md) | Examined development examples | 2/2 now CSV; **not** an unbiased holdout |

The five ordinary CSV files came from [Seaborn's example data repository](https://github.com/mwaskom/seaborn-data) and [Plotly's example datasets](https://github.com/plotly/datasets). The three GISS tables came from [NASA's GISTEMP CSV downloads](https://data.giss.nasa.gov/gistemp/data_v4.html), which explicitly identify them as CSV. Each source file is stored locally under a Git-ignored directory, and the [ordinary CSV manifest](fresh-csv-manifest.json) and [GISS manifest](preamble-csv-manifest.json) freeze their SHA-256 hashes. Labels and rights status still await human review. The GISS evaluation's basic structural check says `needs_review` because it expects a uniform table from line one; the independent source page and file inspection support the provisional CSV label.

The five TXT files come from [GNU's license text](https://www.gnu.org/licenses/gpl), [CPython](https://github.com/python/cpython), [Node.js](https://github.com/nodejs/node), [Go](https://github.com/golang/go), and [Rust](https://github.com/rust-lang/rust). They are readable prose, but license text does not cover the full variety of notes and reports users might upload. Their [frozen manifest](fresh-txt-manifest.json) records sources and SHA-256 hashes.

The 16 edge checks include a short preamble followed by comma and semicolon tables, comma-filled prose, inconsistent row widths, and an over-limit preamble. No filename or browser MIME hint is used. This is a tiny source check, not a measured accuracy rate across real uploads. It includes only three new preamble CSVs from one provider and five TXT negatives that are all license documents. The random forest and the application API were unchanged.

## Reproduce

From the repo root, run `powershell -NoProfile -ExecutionPolicy Bypass -File docs/ml/fetch_fresh_sources.ps1` with the default set and with `-Set preamble-csv` and `-Set fresh-txt` to download or verify frozen bytes. Then run `python docs/ml/evaluate_fresh_sources.py` with the same `--set` values. Run `python docs/ml/evaluate_content_detector.py` for the original local pilot. The Python checks run offline after download.

Before release, have a human verify labels and test more independent CSV and TXT sources, including varied preambles, prose other than licenses, text-only tables, damaged files, and large files. The original 20-file batch is now development data; do not report a retest of it as fresh accuracy.

## Pilot decision

Keep the deterministic detector offline for now. The original [new-source check](new-source-report.md) showed the random forest offered only three suggestions out of 20 files at its uncalibrated cutoff, all JSON. The revised detector's small follow-up checks are promising, but they do not establish a safe threshold or broad coverage. Review labels and gather more independent positive and negative sources before deciding whether supervised ML adds value to the upload experience.

A later [synthetic stress check](content-detector-stress-report.md) found two false format suggestions in its original 13 cases. The [ambiguity follow-up](ambiguity-follow-up.md) records the subsequent rule change and retest.
