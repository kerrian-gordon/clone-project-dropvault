# Local folder label review

This dataset is for an **offline** comparison of folder suggestions. It is not collected by the app. Ask each account holder for consent before recording any filenames. Keep the JSON only in `docs/ml/private-folder-data/`, which is Git-ignored, and do not commit, upload, or paste it into reports. Use a random account pseudonym and a fresh random UUID v4 as each file's stable `fileKey`. Reuse the same key if a file is renamed; the validator will reject its duplicate row.

Before collecting holdout files, choose a UTC date cutoff and record the moment it was selected. Review the earlier training rows before that moment. For each file, show a human reviewer the filename and candidate folders **without either suggester's answer**. Record their intended folder even if it is the current folder. Review later files only after they are observed. Preserve rows in observation order. Suggested destinations, accepted suggestions, and existing placement alone are not reviewed labels.

Save JSON like this in `docs/ml/private-folder-data/reviewed.json`:

```json
{
  "schemaVersion": 1,
  "review": {
    "consentRecorded": true,
    "collectionMethod": "prospective",
    "labelMethod": "blind_human_review",
    "cutoff": "2026-01-10",
    "cutoffSelectedAt": "2026-01-09T00:00:00Z"
  },
  "examples": [
    {
      "accountId": "account_01",
      "fileKey": "123e4567-e89b-42d3-a456-426614174000",
      "observedAt": "2026-01-07T12:00:00Z",
      "name": "beach.jpg",
      "currentFolderId": "root",
      "targetFolderId": "photos",
      "folders": [{ "id": "photos", "name": "Photos" }],
      "labelSource": "human_reviewed",
      "reviewerDecision": {
        "reviewedAt": "2026-01-08T12:00:00Z",
        "choice": "move",
        "blindToSuggestions": true
      }
    },
    {
      "accountId": "account_01",
      "fileKey": "123e4567-e89b-42d3-a456-426614174001",
      "observedAt": "2026-01-11T12:00:00Z",
      "name": "draft.txt",
      "currentFolderId": "photos",
      "targetFolderId": "photos",
      "folders": [{ "id": "photos", "name": "Photos" }],
      "labelSource": "human_reviewed",
      "reviewerDecision": {
        "reviewedAt": "2026-01-11T13:00:00Z",
        "choice": "keep",
        "blindToSuggestions": true
      }
    }
  ]
}
```

The example above illustrates the schema only; do not use it to estimate accuracy. A real dataset should include varied account folders, intended moves, intended stays, ambiguous names, and cases where the rule offers nothing. `folders` lists the candidate folders available when the file was observed; include the current folder when it is not `root`. A target must be the current folder or a candidate. `choice` is `keep` for the current folder and `move` for another folder. The metadata records the review procedure; the validator cannot independently prove that consent or blinding occurred.

Validate locally:

```sh
node scripts/validate-folder-labels.mjs docs/ml/private-folder-data/reviewed.json
```

The command prints only validation status, row count, and cutoff. Errors are deliberately generic so a malformed JSON snippet or private filename does not enter the terminal log. The validator rejects synthetic or mixed labels, malformed dates, missing consent or blind decision metadata, duplicate file keys or account filenames, duplicate folder IDs, rows out of observation order, late training labels, and a cutoff without both earlier training and later holdout rows. It accepts only the documented keys, so reviewer names and other private path fields cannot be added accidentally.

Once valid, run the evaluator using the same cutoff. Keep any detailed per-file inspection within the private local folder; report aggregate counts only.
