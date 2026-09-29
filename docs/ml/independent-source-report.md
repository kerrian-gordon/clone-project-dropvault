# Small source-separated file recognition check

This is an offline challenge for the [pilot model](pilot_file_recognition.py), not an upload feature or a release metric. The [runner](test_independent_sources.py) reads five existing repository files and writes [per-file results](independent-source-results.json). It trains only on the original 40 synthetic candidates; none of the five challenge files train the model. Hash checks exclude byte-identical training copies.

## Run and result

Run on 2026-09-28 in WSL Ubuntu with Python 3.14.4 and scikit-learn 1.9.1. This differs from the pilot's pinned scikit-learn 1.6.1 because the available WSL Python is newer. The original pilot was rerun in 1.9.1 first and reproduced its main figures: 38/40 raw cross-validation predictions, 12/12 out-of-scope abstentions, and the separate demo PPTX abstention.

| Challenge source | Actual | Model raw guess | Score | At 0.60 | Content rule |
| --- | --- | --- | ---: | --- | --- |
| Project presentation | PPTX | DOCX | 0.39 | Abstain | PPTX |
| Web mock drive | JSON | JSON | 0.72 | Suggest | JSON |
| Web multi-user mock | JSON | JSON | 0.75 | Suggest | JSON |
| Root package config | JSON | JSON | 0.86 | Suggest | JSON |
| API baseline table | CSV | JSON | 0.30 | Abstain | CSV |

Raw model accuracy was **3/5**. The abstention rule made **3/5 suggestions, all correct**; it gave no usable answer for PPTX or CSV. The simple content rule identified **5/5**, though it only implements the three formats in this challenge. Its 5/5 figure is not an eight-class benchmark. The two web JSON fixtures share a source group, so these are four source groups, not five independent sources.

## Limits and decision

Labels were assigned from known project files and checked by parsing their content, but provenance and labels still need human review. The presentation file currently lives in the untracked `presentations/` directory, so another checkout cannot reproduce that case without the file. All five challenge files are local project artifacts; this is source separation from the training generator, not an external collection of real user documents. There is no coverage here for PDF, DOCX, XLSX, TXT, ZIP, damaged files, or diverse out-of-scope formats. The model scores are not calibrated probabilities.

**Do not publish the model as an upload feature yet.** First collect permission-cleared, reviewed files made by different applications for every class, keep entire source groups out of training, and compare the model with a complete deterministic content detector. The current result suggests that structural parsing may solve the first format-recognition use case more reliably than this tiny supervised model.

To rerun from the repository root with scikit-learn installed, use `python docs/ml/pilot_file_recognition.py` followed by `python docs/ml/test_independent_sources.py`. The challenge reads the five files but does not modify them or the application.
