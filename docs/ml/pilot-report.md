# Local supervised file recognition pilot

This is an **offline experiment**, not a Dropvault upload feature or a deployment-ready model. The training labels in the [manifest](file-recognition-manifest.csv) still await human review. No user-uploaded files were used.

## Setup

- [Pilot script](pilot_file_recognition.py): scikit-learn 1.6.1 random forest with 100 trees, fixed seed 7, using file bytes and structure but **no filename or extension** as features.
- Eight known labels: PDF, DOCX, PPTX, XLSX, JSON, CSV, TXT, ZIP. Forty synthetic candidate files supply five examples per label. Out-of-scope files do not train the classifier.
- Features include byte positions and frequencies, text characteristics, and simple structural checks such as ZIP package parts or whether text parses as JSON/CSV. These hand-built signals help the model and could also support a deterministic detector.
- Five-fold stratified cross-validation tests one example per label in each fold. Related renamed copies are excluded from training and evaluated only after their original `family_id` is removed from that training run.
- An uncalibrated top-class score below **0.60** means “abstain” in this pilot. This threshold was chosen before reading the results; it is not a calibrated confidence percentage.

## Observed results

| Check | Result |
| --- | --- |
| Cross-validation on 40 same-source candidates | 38/40 correct raw predictions (95%). Two JSON files were guessed as TXT. |
| With the 0.60 abstention rule | 35/40 known samples received a suggestion, and all 35 suggestions were correct in this small run. Five known samples abstained, including both JSON mistakes. |
| Out-of-scope challenge | All 12 abstained at 0.60. These formats were chosen during dataset construction, so this does not establish unknown-format performance generally. |
| Three renamed probes | PDF, DOCX, and JSON were all identified after their matching original family was excluded from each training run. |
| Separate-source PPTX demo deck | Predicted PPTX but scored 0.30, so it abstained. This is a warning about source generalization. |

The [machine-readable results](pilot-results.json) include every prediction, score, class report, and confusion matrix. The [current API baseline](file-recognition-baseline.md) accepts the three renamed probes under their misleading extensions. The model recognized them in this pilot, but the comparison is **not yet a fair product benchmark**: the model receives extra content and structural features, and a stronger rule-based detector could use those same signals.

## Decision

Keep the model offline. The tiny, single-generator training set makes the 95% figure an optimistic within-source measurement. The separate-source PPTX abstention shows that a model can fail to provide a usable suggestion on a valid document. The scores are uncalibrated and must not be shown as probabilities. Dropvault's current upload validation remains the authority for acceptance.

Before a product trial: review labels, collect independent-source files for every class, reserve entire source groups for testing, compare against stronger deterministic content detection, and assess both wrong suggestions and abstentions. Only then consider adding a bounded recognition suggestion to the API or UI.

A [small source-separated follow-up](independent-source-report.md) tests existing project files. It found the model abstained on a separate PPTX and CSV while a simple content rule identified both. This strengthens the decision to keep the model offline.

A [local Apache Tika comparison](tika-benchmark.md) tests the same pilot samples with and without filename hints. Tika handles the binary and Office examples well here but treats JSON and CSV as plain text when no filename is supplied.

An [offline content detector prototype](content-detector-report.md) combines structural checks and text parsing without filename hints. It identifies the current 61 files, but that set is too small and source-concentrated to estimate performance on arbitrary uploads.

The [frozen new-source check](new-source-report.md) tests five additional files each for PPTX, JSON, CSV, and TXT without retraining this model. The random forest made three usable suggestions out of 20 files at the exploratory 0.60 cutoff.

## Reproduce locally

With Python and the packages in [pilot-requirements.txt](pilot-requirements.txt) installed, run `python docs/ml/pilot_file_recognition.py` from the repo root. The script verifies every sample hash and rewrites `pilot-results.json`. It does not save a model artifact or change application code.
