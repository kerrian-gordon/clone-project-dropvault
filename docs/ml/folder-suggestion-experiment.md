# Folder suggestion experiment

DropVault's live folder suggestion remains the rule in [`suggest.js`](../../apps/api/src/modules/files/suggest.js). This experiment trains a small **per-account multinomial naive Bayes** classifier on reviewed file placements, compares it with the live rule on later examples, and offers nothing to users. The model uses filename words and extension only; it never reads file content. It can abstain when an account or folder has too few examples, no familiar filename evidence, or no clear winner. Its score margin is a cautious experiment setting, not a calibrated probability.

## Run the plumbing check

```sh
npm run pilot:folders -- docs/ml/folder-suggestion-demo.json 2026-01-10
```

The fixture is entirely synthetic. Six examples precede the cutoff and seven follow it. On those seven invented cases, the live rules make four correct offers, two wrong offers, and one abstention. The model makes five correct offers, zero wrong offers, and two abstentions. These counts only check that the pipeline works; they say **nothing** about performance on real DropVault users. The model does not help on the rule's one abstention in this fixture.

## Collect useful prospective examples

The current `/v1/organization/stats` counters are not labels. Accepting a suggestion does not prove it was the best folder, and declining one does not identify another correct folder. No filenames or choices are automatically copied into this experiment.

With an account holder's consent, make a local JSON file under `docs/ml/private-folder-data/` (this directory is Git-ignored). Follow the separate [reviewed-label schema and procedure](folder-label-review.md), which records consent, a cutoff chosen in advance, stable opaque file keys, and blind human decisions. Record the intended destination **without showing either suggester's answer**. Include cases that should stay in the current folder, ambiguous names, new folders, and files for which the existing rule offers nothing. Do not put private filenames in Git or public reports. The evaluator requires the reviewed-label validator for real data and rejects a mix of synthetic and reviewed labels.

```sh
node scripts/validate-folder-labels.mjs docs/ml/private-folder-data/reviewed.json
npm run pilot:folders -- docs/ml/private-folder-data/reviewed.json 2026-01-10
```

[Public GitHub tree fixtures](public-folder-trees.md) can exercise path handling and varied layouts, but their observed directories are unlabeled and cannot be used as accuracy test answers.

Pick a cutoff before examining later labels. The script trains only on rows before it and tests only on rows at or after it. It rejects duplicate account/filename pairs to reduce easy leakage. It reports offers, correct offers, wrong offers, abstentions, and coverage of wanted moves for both methods. Review mistakes per account and folder; a pooled total can hide poor performance for a smaller account. Follow this with a fresh later batch before considering a model in the app. The current model's abstention margin must be chosen on a separate validation set rather than tuned to the final test set. This follows the principle of testing on later data and guarding against feedback and training-serving skew described in [Google's Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml/) and [scikit-learn's evaluation guide](https://scikit-learn.org/stable/modules/cross_validation.html).

Add `--details` after the cutoff to print the per-account and per-extension breakdowns. The default output contains only aggregate counts, and neither form prints filenames. Keep detailed results local when account identifiers could be sensitive.

Only if later, reviewed data show fewer wrong offers at useful coverage should we consider an opt-in shadow run or user-facing model suggestion. Keep the rule and the user's explicit destination choice available.
