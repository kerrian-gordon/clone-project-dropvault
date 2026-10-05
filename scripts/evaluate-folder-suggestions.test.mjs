import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFolderSuggestions, predictFolder, trainFolderModel, validateExamples } from './evaluate-folder-suggestions.mjs';

const folders = [
  { id: 'photos', name: 'Photos' },
  { id: 'documents', name: 'Documents' },
  { id: 'lab', name: 'Lab Data' },
];
const example = (name, targetFolderId, day, currentFolderId = 'root') => ({
  accountId: 'synthetic-lab', observedAt: `2026-01-${String(day).padStart(2, '0')}T12:00:00Z`,
  name, currentFolderId, targetFolderId, folders, labelSource: 'synthetic',
});
const examples = [
  example('beach.jpg', 'photos', 1), example('sunset.png', 'photos', 2),
  example('draft-notes.txt', 'documents', 3), example('meeting-brief.pdf', 'documents', 4),
  example('microscopy-cells.csv', 'lab', 5), example('microscopy-counts.json', 'lab', 6),
  example('portrait.jpg', 'photos', 11), example('garden.png', 'photos', 12),
  example('field-notes.txt', 'documents', 13), example('proposal.pdf', 'documents', 14),
  example('microscopy-images.txt', 'lab', 15), example('microscopy-values.json', 'lab', 16),
  example('unfamiliar.dat', 'lab', 17),
];

test('later synthetic examples compare a personal model with unchanged folder rules', () => {
  const report = evaluateFolderSuggestions(examples, '2026-01-10');
  assert.equal(report.trainingExamples, 6);
  assert.equal(report.testExamples, 7);
  assert.equal(report.baseline.total, 7);
  assert.equal(report.baseline.wrongOffers, 2);
  assert.equal(report.model.total, 7);
  assert.equal(report.model.offered + report.model.missedOpportunities, 7);
  assert.equal(report.modelWhenRuleAbstains.total, 1);
  assert.equal(report.modelWhenRuleAbstains.offered, 0);
  assert.equal(report.byAccount['synthetic-lab'].model.correctOffers, report.model.correctOffers);
  assert.equal(Object.values(report.byExtension).reduce((sum, item) => sum + item.baseline.total, 0), 7);
});

test('model abstains without account history, matching evidence, or a clear winner', () => {
  const model = trainFolderModel(examples.slice(0, 6));
  assert.equal(predictFolder(model, { ...example('beach.jpg', 'photos', 18), accountId: 'other' }), null);
  assert.equal(predictFolder(model, example('unknown.dat', 'lab', 18)), null);
  assert.equal(predictFolder(model, example('microscopy-cells.txt', 'lab', 18, 'lab')), null);
});

test('dataset checks reject duplicate filenames and invalid reviewed targets', () => {
  assert.throws(() => validateExamples([...examples, example('beach.jpg', 'photos', 19)], '2026-01-10'),
    /Duplicate account and filename/u);
  assert.throws(() => validateExamples([...examples, example('bad.bin', 'missing', 19)], '2026-01-10'),
    /reviewed target/u);
});

test('reviewed labels require provenance before they can be scored', () => {
  const rows = [example('beach.jpg', 'photos', 7), example('sunset.png', 'photos', 11)]
    .map((item, index) => ({ ...item, labelSource: 'human_reviewed',
      fileKey: `123e4567-e89b-42d3-a456-42661417400${index}`,
      reviewerDecision: { reviewedAt: index ? '2026-01-11T13:00:00Z' : '2026-01-08T12:00:00Z',
        choice: 'move', blindToSuggestions: true } }));
  const reviewed = { schemaVersion: 1, review: { consentRecorded: true,
    collectionMethod: 'prospective', labelMethod: 'blind_human_review',
    cutoff: '2026-01-10', cutoffSelectedAt: '2026-01-09T00:00:00Z' }, examples: rows };
  assert.throws(() => evaluateFolderSuggestions(rows, '2026-01-10'), /review metadata/u);
  assert.equal(evaluateFolderSuggestions(reviewed, '2026-01-10').labelSource, 'human_reviewed');
});
