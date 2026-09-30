# File recognition dataset inventory

Planning artifact for the supervised **file format** pilot. This is not a training dataset yet. Recognition may suggest a format or `OUT_OF_SCOPE`; the API's current upload validation remains authoritative.

The [provisional validation baseline](file-recognition-baseline.md) records how the current API type checks treat this first sample batch. It does not turn the synthetic samples into a training-ready dataset.

The [local supervised pilot](pilot-report.md) trains an exploratory classifier on the synthetic candidates. Its within-source result is not a deployment metric.

A [frozen new-source check](new-source-report.md) adds 20 local, Git-ignored challenge files across PPTX, JSON, CSV, and TXT. Their URLs and hashes are recorded separately; they are not part of the original 56-row manifest or the model's training set.

The [CSV preamble follow-up](csv-preamble-report.md) adds fresh CSV and plain-text negative checks for the revised content detector. These are evaluation files, not model training data.

The [second source-separated check](holdout-v2-report.md) tests the later ambiguity rule on nine newly selected files, including all-text CSV and varied PDFs. Its first-run score and limitations are recorded separately from the earlier development retests.

## Agreed labels

`PDF`, `DOCX`, `PPTX`, `XLSX`, `JSON`, `CSV`, `TXT`, `ZIP`, and `OUT_OF_SCOPE`. Track `DAMAGED` as a separate condition, not a format. `TXT` means ordinary unstructured text; recognizable markup formats such as XML, HTML, and SVG are `OUT_OF_SCOPE` in this pilot even though their bytes are readable text. Renamed files get the label indicated by verified content. Ambiguous text, conflicting formats, encrypted containers that cannot be inspected, and truncated files go to review before any training split.

## What exists now

The accompanying [manifest](file-recognition-manifest.csv) records 56 physical files. The first collection pass created **five candidate files for each named label** and **eleven out-of-scope candidates** (PNG, JPEG, GIF, WebP, WAV, GZIP, TAR, BZIP2, XML, SVG, HTML). Every generated candidate was reopened or parsed according to its format. They are synthetic, permission-cleared examples with varied layouts or contents, but each named label still relies on a single generator/source group. Human review is pending, and this batch is **not ready for model training or evaluation**.

The repository also has the original Dropvault-created `q4-deck.pptx` and MDN CC0 `flower.mp4`, plus three byte-identical copies renamed to misleading extensions. These five rows are `smoke_only`, excluded from training and held-out scoring. The demo seed script generates PDF and TXT bytes when run, but those are variations of a fixed template. Web mock JSON files contain metadata, not document bytes. API tests create temporary fixtures; they are not independent training examples.

| Label | New candidates | Exploratory target | Remaining count before source review |
| --- | ---: | ---: | ---: |
| PDF | 5 | 30 | 25 |
| DOCX | 5 | 30 | 25 |
| PPTX | 5 | 30 | 25 |
| XLSX | 5 | 30 | 25 |
| JSON | 5 | 30 | 25 |
| CSV | 5 | 30 | 25 |
| TXT | 5 | 30 | 25 |
| ZIP | 5 | 30 | 25 |
| OUT_OF_SCOPE | 11 | 30 across several formats | 19 |

These are **exploratory targets**, not a claim that 30 samples per label is enough for deployment. Before splitting or training, collect from multiple independent tools or generators per label and add oddly encoded, protected, and damaged examples for review. Do not train on private user uploads without an explicit data-use decision and permission.

## Manifest rules

One row represents one physical file. Record a SHA-256 hash to identify duplicates, a `family_id` for copies or derivatives of the same document, and a `source_group` for the generator or collection source. Related families and source groups must not be split across training and test sets. Group-aware evaluation avoids scoring the model on close relatives of its training examples ([scikit-learn guidance](https://scikit-learn.org/1.1/modules/cross_validation.html#cross-validation-iterators-for-grouped-data)).

`condition` is `valid`, `damaged`, or `needs_review`. `review_status` is `verified` only after a person checks the content and provenance; otherwise use `pending`. `usage` is `candidate`, `smoke_only`, or `excluded`. Leave `split` blank until the inventory is reviewed and groups are assigned together. A changed file gets a new hash and row. Never infer the ground-truth label only from the extension or browser-supplied MIME type; ZIP-based formats need container inspection ([Apache Tika detection guide](https://tika.apache.org/3.2.3/detection.html)).

Keep private sample bytes outside Git. Only add a path to this public manifest when the file itself is approved for this repository. For private or permission-limited examples, maintain a separate local manifest outside the repo rather than exposing filenames or hashes here.

## Next collection pass

1. Find or create varied, permission-cleared files for each in-scope label; record their source and usage rights.
2. Have one person assign the label from content and another review ambiguous cases. Preserve the reason for every disputed label.
3. Deduplicate by hash and mark derivatives with the same `family_id`.
4. Add damaged, protected, and differently generated examples as a challenge set. Keep known upload-security failures out of model training until their role is defined.
5. Review labels and source diversity before choosing a train/test split. The current batch is only an initial collection pass.
