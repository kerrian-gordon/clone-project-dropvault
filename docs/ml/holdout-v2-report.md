# Second source-separated file recognition check

The [plan](holdout-v2-plan.json) selected nine public files before running the detector. The [manifest](holdout-v2-manifest.json) freezes their URLs, source groups, sizes, and SHA-256 hashes. Downloaded bytes stay in a Git-ignored folder. One planned Git release-note URL returned 404 and was replaced with the Linux README **before scoring**; the plan records that change. Labels remain provisional and await human review.

Sources: [philocalyst color names](https://github.com/philocalyst/color-names), [ColourMapper](https://github.com/rondomondo/colourmapper), [Google Research BERT](https://github.com/google-research/bert), [Linux](https://github.com/torvalds/linux), [tinytoolkit PDF samples](https://github.com/tinytoolkit-org/pdf-sample-files), and [OpenPrinting sample files](https://github.com/OpenPrinting/sample-files). The tinytoolkit project documents its intentionally corrupted and password-protected samples. No private uploads were used; external bytes are not committed to this repository.

## First run, with the detector unchanged

| Expected group | Files | Matched | `UNKNOWN` on valid files | Wrong suggestions |
| --- | ---: | ---: | ---: | ---: |
| CSV | 2 | 1 | 1 | 0 |
| TXT | 2 | 2 | 0 | 0 |
| Valid PDF | 4 | 4 | 0 | 0 |
| Damaged PDF, expected `UNKNOWN` | 1 | 1 | — | 0 |
| **Total** | **9** | **8** | **1** | **0** |

The [first-run per-file results](holdout-v2-first-results.json) show that ColourMapper's valid three-column, all-text CSV returned `UNKNOWN` (`ambiguous_text_table`). This is the deliberate abstention introduced to avoid calling comma-heavy prose CSV. It is a real coverage gap for all-text tables.

The philocalyst CSV received a CSV suggestion, but inspection found a color named `Infinity` on data row 13,428. Python's `float()` accepts that word, so the detector treated it as numeric table evidence. This was an accidental trigger, not convincing evidence that the rule handles all-text CSV.

## Development retest after the numeric fix

The detector now accepts only **finite** numeric values as CSV evidence. `Infinity`, `NaN`, and similar words no longer qualify. New synthetic checks cover an ordinary numeric table and non-finite words both with and without a text preamble.

The [current retest](holdout-v2-results.json) matched **7/9** expectations: both valid all-text CSVs returned `UNKNOWN`, the two TXT and four valid PDF files matched, and the damaged PDF returned `UNKNOWN`. There were **zero wrong format suggestions**. This lower match count is an intentional abstention tradeoff, not a new independent accuracy estimate; the same nine files were already examined. The broader local stress check passed 18/18 stated expectations, the available original pilot matched 57/58 labels with one all-text CSV abstention, and the three preamble CSV examples still matched.

The four valid PDF samples received PDF suggestions and the provider's truncated sample returned `UNKNOWN`. We had no independent PDF parser available in the pilot environment, so PDF validity comes from provider descriptions rather than separate parsing. PDF hints still do not establish upload safety.

Nine files, including four PDFs from one provider, cannot estimate real-world accuracy. TXT examples are broader than the earlier license-only negatives but still do not recreate arbitrary user notes. The supervised random forest was not retrained or scored here; this check targeted the changed content detector. No application code or upload API changed.

Run `powershell -NoProfile -ExecutionPolicy Bypass -File docs/ml/fetch_holdout_v2.ps1` to download or verify the frozen bytes, then `python docs/ml/evaluate_holdout_v2.py` to reproduce the current development retest. The first-run JSON is preserved separately.
