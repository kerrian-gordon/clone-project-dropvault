# File recognition baseline: current upload checks

This is a provisional measurement of the current Dropvault validation functions against the [first-pass sample manifest](file-recognition-manifest.csv). It is **not** a model result or a full HTTP upload test. The candidate labels still await human review, and the synthetic set has little source diversity.

## Method

For each of the 56 manifest rows, the evaluation called `uploadDetails` and `validateStoredFile` with the sample's actual bytes and filename. It supplied `Content-Type: application/octet-stream`, which the API permits, so a browser's MIME hint would not decide the result. Office and ZIP inspection used the API's `zipEntryNames` function. The [per-file results](file-recognition-baseline.csv) record the upload-validation outcome and the type suggested by the filename extension.

The current API does not have a content-based type prediction endpoint. `extension_guess` is therefore a **proxy baseline** for the recognition task, not an API response. `ACCEPTED` means the file passes the tested type checks; it does not mean the API identified the correct label or completed storage and quota checks.

## Results

| Group | Files | Observed result |
| --- | ---: | --- |
| Named pilot formats | 44 | All pass type validation. The extension agrees with the content label for 41; three deliberately renamed copies are accepted under the wrong extension. |
| Out-of-scope formats | 12 | Six pass because Dropvault supports those uploads (PNG, JPEG, GIF, WebP, GZIP, MP4). Six return `UNSUPPORTED_FILE_TYPE` because their extensions are outside the upload allowlist (WAV, TAR, BZIP2, XML, SVG, HTML). |
| Total | 56 | 50 accepted by the tested type checks; six rejected as unsupported. |

The renamed probes are byte-identical copies of existing candidates and are marked `smoke_only`. They must not be counted as independent test examples. They show a concrete behavior to improve: a PDF named `.txt`, a DOCX named `.zip`, and JSON named `.txt` all pass the current type checks with the extension's type. A supervised recognizer could suggest the content-based label in these cases, while the API's acceptance policy remains separate.

## Next gate

Review the manifest labels and provenance, collect independent-source examples for each named format, and reserve source groups for a held-out test set. Then compare a trained model with this baseline on those unseen sources. The present results describe this small synthetic batch only.
