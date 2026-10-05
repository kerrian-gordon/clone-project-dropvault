# File recognition in the uploader

The web uploader reads at most 8 MiB of each selected file in the browser and tries to recognize PDF, DOCX, PPTX, XLSX, JSON, CSV, TXT, or ZIP from its contents. It does not send this sample to a separate service. It ignores the filename and browser MIME type when making the guess. Empty, oversized, malformed, ambiguous, and unsupported content can return `UNKNOWN`.

When a recognized format matches the filename extension, the upload queue shows a content hint and continues. When the two disagree, that file waits for **Upload anyway** or **Skip file**. The user can inspect and rename the original file before selecting it again. An unknown result continues normally. A recognition error also falls back to the existing upload flow. A folder suggestion, if any, still needs its own explicit choice.

Recognition is advice, not file validation. The API still enforces its supported extensions, declared MIME types, size limit, and existing content checks. The detector does not prove that a document is safe, complete, or renderable. It does not change names, folders, versions, or stored metadata. Other entry points, including workspace upload and version replacement, retain their existing validation but do not show this hint yet.

## Why this detector

The supervised random-forest pilot offered correct suggestions for only 3 of 20 new-source files at its chosen threshold, with the rest mostly abstaining; labels were provisional. It is not a useful upload feature on that evidence. The offline Python content detector was more promising, but its independent checks are small: the initial 20-file new-source batch matched 18 labels, and a later nine-file holdout had eight matches and one abstention. Those numbers were measured on the Python prototype, **not** this browser implementation, and are **not** an estimate of accuracy on user uploads. The browser implementation has focused format and ambiguity checks plus a real compressed Office browser check. See [the pilot report](ml/pilot-report.md), [new-source report](ml/new-source-report.md), and [holdout report](ml/holdout-v2-report.md).

## Release boundary

The current product behavior is a conservative **hint**. Before using recognition to reject uploads, rename files, select a folder automatically, or claim a measured accuracy rate, collect permissioned files from independent sources across all eight formats and realistic unsupported formats. Have people review labels without seeing detector output, freeze the set, and report coverage and wrong suggestions separately by format. Include damaged documents, renamed files, text tables, comma-heavy prose, and files over 8 MiB. Keep the server validator as the authority even if those later checks are favorable.
