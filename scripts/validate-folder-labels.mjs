import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}

function isoInstant(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !isoDay(`${match[1]}-${match[2]}-${match[3]}`)
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return false;
  if (match[8] && (Number(match[9]) > 14 || Number(match[10]) > 59
    || (Number(match[9]) === 14 && Number(match[10]) !== 0))) return false;
  return Number.isFinite(Date.parse(value));
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

/**
 * Validate a consented, prospective, human-reviewed dataset without printing row data.
 * Returns the evaluator-compatible examples array. Throws generic, filename-free errors.
 */
export function validateReviewedDataset(data, cutoff = data?.review?.cutoff) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !exactKeys(data, ['schemaVersion', 'review', 'examples'])
    || data.schemaVersion !== 1 || !data.review || typeof data.review !== 'object'
    || Array.isArray(data.review)
    || !exactKeys(data.review, ['consentRecorded', 'collectionMethod', 'labelMethod', 'cutoff', 'cutoffSelectedAt'])
    || data.review.consentRecorded !== true
    || data.review.collectionMethod !== 'prospective'
    || data.review.labelMethod !== 'blind_human_review'
    || !isoDay(data.review.cutoff) || cutoff !== data.review.cutoff
    || !isoInstant(data.review.cutoffSelectedAt)
    || Date.parse(data.review.cutoffSelectedAt) >= Date.parse(`${cutoff}T00:00:00Z`)
    || !Array.isArray(data.examples) || data.examples.length < 2) {
    fail('Invalid reviewed dataset metadata or cutoff.');
  }

  const seenFiles = new Set();
  const seenNames = new Set();
  let previousObservedAt = -Infinity;
  let training = 0;
  let holdout = 0;
  const cutoffTime = Date.parse(`${cutoff}T00:00:00Z`);
  const selectedAt = Date.parse(data.review.cutoffSelectedAt);

  for (const item of data.examples) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !exactKeys(item, ['accountId', 'fileKey', 'observedAt', 'name', 'currentFolderId',
        'targetFolderId', 'folders', 'labelSource', 'reviewerDecision'])
      || item.labelSource !== 'human_reviewed'
      || !/^[A-Za-z0-9_-]{3,64}$/u.test(item.accountId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.fileKey)
      || !nonempty(item.name) || /[\\/]/u.test(item.name)
      || !nonempty(item.currentFolderId)
      || !nonempty(item.targetFolderId) || !isoInstant(item.observedAt)
      || !Array.isArray(item.folders) || !item.folders.length
      || !item.reviewerDecision || typeof item.reviewerDecision !== 'object'
      || Array.isArray(item.reviewerDecision)
      || !exactKeys(item.reviewerDecision, ['reviewedAt', 'choice', 'blindToSuggestions'])
      || !isoInstant(item.reviewerDecision.reviewedAt)
      || !['move', 'keep'].includes(item.reviewerDecision.choice)
      || item.reviewerDecision.blindToSuggestions !== true) {
      fail('Invalid reviewed example or missing blind reviewer decision.');
    }

    const observedAt = Date.parse(item.observedAt);
    const reviewedAt = Date.parse(item.reviewerDecision.reviewedAt);
    if (observedAt < previousObservedAt || reviewedAt < observedAt) {
      fail('Examples must be observed in order and reviewed after observation.');
    }
    previousObservedAt = observedAt;

    const ids = new Set();
    for (const folder of item.folders) {
      if (!folder || typeof folder !== 'object' || Array.isArray(folder)
        || !exactKeys(folder, ['id', 'name'])
        || !nonempty(folder.id) || !nonempty(folder.name) || folder.id === 'root'
        || ids.has(folder.id)) fail('Invalid or duplicate candidate folder.');
      ids.add(folder.id);
    }
    if ((item.currentFolderId !== 'root' && !ids.has(item.currentFolderId))
      || (item.targetFolderId !== item.currentFolderId && !ids.has(item.targetFolderId))
      || (item.reviewerDecision.choice === 'keep') !== (item.targetFolderId === item.currentFolderId)) {
      fail('Reviewed decision and candidate folders disagree.');
    }

    // A stable opaque file key also catches the same file under a changed name.
    const accountKey = item.accountId.toLowerCase();
    const fileKey = `${accountKey}\0${item.fileKey.toLowerCase()}`;
    const nameKey = `${accountKey}\0${item.name.normalize('NFKC').trim().toLowerCase()}`;
    if (seenFiles.has(fileKey) || seenNames.has(nameKey)) {
      fail('Duplicate file or account filename can leak across the split.');
    }
    seenFiles.add(fileKey);
    seenNames.add(nameKey);

    if (observedAt < cutoffTime) {
      training += 1;
      if (reviewedAt > selectedAt) fail('Training labels must be frozen before the cutoff is selected.');
    } else {
      holdout += 1;
      if (observedAt < selectedAt) fail('Holdout observations must follow cutoff selection.');
    }
  }

  if (!training || !holdout) fail('Cutoff must leave training and later holdout examples.');
  return data.examples;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const datasetPath = process.argv[2];
  if (!datasetPath) {
    console.error('Usage: node scripts/validate-folder-labels.mjs DATASET.json');
    process.exitCode = 2;
  } else {
    try {
      const data = JSON.parse(await readFile(datasetPath, 'utf8'));
      const examples = validateReviewedDataset(data);
      console.log(JSON.stringify({ valid: true, examples: examples.length,
        cutoff: data.review.cutoff }));
    } catch {
      // JSON parser and filesystem errors can include private source text or paths.
      console.error('Reviewed dataset validation failed. Check the local schema and timestamps.');
      process.exitCode = 1;
    }
  }
}
