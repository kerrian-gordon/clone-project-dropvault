import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReviewedDataset } from './validate-folder-labels.mjs';

const folders = [{ id: 'photos', name: 'Photos' }, { id: 'docs', name: 'Documents' }];
const fileKeys = [
  '123e4567-e89b-42d3-a456-426614174000',
  '123e4567-e89b-42d3-a456-426614174001',
];

function dataset() {
  return {
    schemaVersion: 1,
    review: {
      consentRecorded: true,
      collectionMethod: 'prospective',
      labelMethod: 'blind_human_review',
      cutoff: '2026-01-10',
      cutoffSelectedAt: '2026-01-09T00:00:00Z',
    },
    examples: [
      {
        accountId: 'account_01', fileKey: fileKeys[0],
        observedAt: '2026-01-07T12:00:00Z', name: 'beach.jpg',
        currentFolderId: 'root', targetFolderId: 'photos', folders: structuredClone(folders),
        labelSource: 'human_reviewed',
        reviewerDecision: {
          reviewedAt: '2026-01-08T12:00:00Z', choice: 'move', blindToSuggestions: true,
        },
      },
      {
        accountId: 'account_01', fileKey: fileKeys[1],
        observedAt: '2026-01-11T12:00:00Z', name: 'notes.txt',
        currentFolderId: 'docs', targetFolderId: 'docs', folders: structuredClone(folders),
        labelSource: 'human_reviewed',
        reviewerDecision: {
          reviewedAt: '2026-01-11T13:00:00Z', choice: 'keep', blindToSuggestions: true,
        },
      },
    ],
  };
}

function rejects(change, pattern) {
  const data = dataset();
  change(data);
  assert.throws(() => validateReviewedDataset(data), pattern);
}

test('returns evaluator-compatible reviewed examples without modifying them', () => {
  const data = dataset();
  assert.equal(validateReviewedDataset(data), data.examples);
  assert.equal(data.examples[1].targetFolderId, 'docs');
  assert.throws(() => validateReviewedDataset(data, '2026-01-12'), /metadata or cutoff/u);
});

test('requires consent, prospective blind review, and a preselected cutoff', () => {
  rejects((data) => { data.review.consentRecorded = false; }, /metadata or cutoff/u);
  rejects((data) => { data.review.labelMethod = 'suggestion_acceptance'; }, /metadata or cutoff/u);
  rejects((data) => { data.review.cutoffSelectedAt = '2026-01-10T00:00:00Z'; }, /metadata or cutoff/u);
  rejects((data) => { data.review.cutoff = '2026-02-30'; }, /metadata or cutoff/u);
  rejects((data) => { data.examples[0].reviewerDecision.blindToSuggestions = false; }, /blind reviewer/u);
  rejects((data) => { data.examples[0].reviewerDecision.reviewerName = 'Private Name'; }, /blind reviewer/u);
});

test('rejects synthetic, mixed, malformed, and inconsistent labels', () => {
  rejects((data) => { data.examples[1].labelSource = 'synthetic'; }, /blind reviewer/u);
  rejects((data) => { data.examples[0].fileKey = 'beach.jpg'; }, /blind reviewer/u);
  rejects((data) => { data.examples[1].targetFolderId = 'photos'; }, /candidate folders disagree/u);
  rejects((data) => { data.examples[1].folders.push({ id: 'docs', name: 'Documents' }); }, /candidate folder/u);
  rejects((data) => { data.examples[0].name = ''; }, /blind reviewer/u);
  rejects((data) => { data.examples[0].name = 'private/beach.jpg'; }, /blind reviewer/u);
  rejects((data) => { data.examples[1].targetFolderId = 'missing'; data.examples[1].reviewerDecision.choice = 'move'; }, /candidate folders disagree/u);
});

test('rejects duplicate file identities and normalized account filenames', () => {
  rejects((data) => { data.examples[1].fileKey = fileKeys[0]; }, /Duplicate file/u);
  rejects((data) => { data.examples[1].fileKey = fileKeys[0].toUpperCase(); }, /Duplicate file/u);
  rejects((data) => { data.examples[1].name = ' BEACH.JPG '; }, /Duplicate file/u);
  rejects((data) => { data.examples[1].accountId = 'ACCOUNT_01'; data.examples[1].name = 'Beach.jpg'; }, /Duplicate file/u);
});

test('rejects out-of-order observations and late training labels', () => {
  rejects((data) => { data.examples.reverse(); }, /observed in order/u);
  rejects((data) => { data.examples[0].reviewerDecision.reviewedAt = '2026-01-06T12:00:00Z'; }, /observed in order/u);
  rejects((data) => { data.examples[0].reviewerDecision.reviewedAt = '2026-01-09T01:00:00Z'; }, /frozen before/u);
  rejects((data) => { data.examples[1].observedAt = '2026-01-08T12:00:00Z'; }, /frozen before|training and later/u);
});
