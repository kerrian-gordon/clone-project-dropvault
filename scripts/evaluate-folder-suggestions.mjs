import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { suggestFolder } from '../apps/api/src/modules/files/suggest.js';
import { validateReviewedDataset } from './validate-folder-labels.mjs';

const MIN_EXAMPLES_PER_FOLDER = 2;
const MIN_LOG_MARGIN = Math.log(2);

function tokens(name) {
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  const stem = name.replace(/\.[^.]+$/u, '');
  const words = stem.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !/^\d+$/u.test(word));
  return [...new Set([...words, ...(extension ? [`ext:${extension}`] : [])])];
}

export function validateExamples(examples, cutoff) {
  if (!Array.isArray(examples) || !examples.length || !/^\d{4}-\d{2}-\d{2}$/u.test(cutoff)
    || !Number.isFinite(Date.parse(cutoff))) {
    throw new Error('Provide nonempty examples and an ISO cutoff date.');
  }
  const seen = new Set();
  for (const item of examples) {
    if (!item || typeof item.accountId !== 'string' || !item.accountId
      || typeof item.name !== 'string' || !item.name
      || typeof item.currentFolderId !== 'string' || !item.currentFolderId
      || typeof item.targetFolderId !== 'string' || !item.targetFolderId
      || !['synthetic', 'human_reviewed'].includes(item.labelSource)
      || !/^\d{4}-\d{2}-\d{2}T/u.test(item.observedAt)
      || !Number.isFinite(Date.parse(item.observedAt))
      || !Array.isArray(item.folders)
      || item.folders.some((folder) => !folder || typeof folder.id !== 'string'
        || typeof folder.name !== 'string')) {
      throw new Error('Each example needs an account, time, name, label source, current and target folders, and candidate folders.');
    }
    const ids = new Set(item.folders.map((folder) => folder.id));
    if (ids.size !== item.folders.length || (item.currentFolderId !== 'root'
      && !ids.has(item.currentFolderId)) || (item.targetFolderId !== item.currentFolderId
      && !ids.has(item.targetFolderId))) {
      throw new Error('The reviewed target must be the current folder or one candidate folder.');
    }
    const key = `${item.accountId}\0${item.name.normalize('NFKC').toLowerCase()}`;
    if (seen.has(key)) throw new Error('Duplicate account and filename can leak an answer across the split.');
    seen.add(key);
  }
  if (new Set(examples.map((item) => item.labelSource)).size !== 1) {
    throw new Error('Keep synthetic and human-reviewed examples in separate datasets.');
  }
  const train = examples.filter((item) => Date.parse(item.observedAt) < Date.parse(cutoff));
  const test = examples.filter((item) => Date.parse(item.observedAt) >= Date.parse(cutoff));
  if (!train.length || !test.length) throw new Error('Cutoff must leave both earlier training and later test examples.');
  return { train, test };
}

/** A small per-account multinomial naive Bayes experiment, never a live route. */
export function trainFolderModel(examples) {
  const accounts = new Map();
  for (const item of examples) {
    let account = accounts.get(item.accountId);
    if (!account) {
      account = { folders: new Map(), vocabulary: new Set(), total: 0 };
      accounts.set(item.accountId, account);
    }
    let folder = account.folders.get(item.targetFolderId);
    if (!folder) {
      folder = { examples: 0, counts: new Map(), tokenTotal: 0 };
      account.folders.set(item.targetFolderId, folder);
    }
    folder.examples += 1;
    account.total += 1;
    for (const token of tokens(item.name)) {
      folder.counts.set(token, (folder.counts.get(token) || 0) + 1);
      folder.tokenTotal += 1;
      account.vocabulary.add(token);
    }
  }
  return accounts;
}

export function predictFolder(model, item) {
  const account = model.get(item.accountId);
  if (!account) return null;
  const candidateIds = new Set(item.folders.map((folder) => folder.id));
  const features = tokens(item.name).filter((token) => account.vocabulary.has(token));
  if (!features.length) return null;
  const ranked = [...account.folders.entries()]
    .filter(([id, folder]) => candidateIds.has(id) && folder.examples >= MIN_EXAMPLES_PER_FOLDER
      && features.some((token) => folder.counts.has(token)))
    .map(([id, folder]) => ({
      id,
      score: Math.log(folder.examples / account.total)
        + features.reduce((sum, token) => sum + Math.log(
          ((folder.counts.get(token) || 0) + 1) / (folder.tokenTotal + account.vocabulary.size)), 0),
    }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || ranked[0].id === item.currentFolderId) return null;
  if (ranked[1] && ranked[0].score - ranked[1].score < MIN_LOG_MARGIN) return null;
  return ranked[0].id;
}

function measures(test, choose) {
  const result = { total: test.length, opportunities: 0, offered: 0,
    correctOffers: 0, wrongOffers: 0, missedOpportunities: 0 };
  for (const item of test) {
    const desiredMove = item.targetFolderId !== item.currentFolderId;
    if (desiredMove) result.opportunities += 1;
    const chosen = choose(item);
    if (chosen) {
      result.offered += 1;
      if (chosen === item.targetFolderId) result.correctOffers += 1;
      else result.wrongOffers += 1;
    } else if (desiredMove) result.missedOpportunities += 1;
  }
  return { ...result,
    offeredPrecision: result.offered ? result.correctOffers / result.offered : null,
    opportunityCoverage: result.opportunities ? result.correctOffers / result.opportunities : null };
}

export function evaluateFolderSuggestions(dataset, cutoff) {
  const examples = Array.isArray(dataset) ? dataset : dataset?.examples;
  if (!Array.isArray(examples) || !examples.length) {
    throw new Error('Provide a dataset with examples.');
  }
  if (examples[0]?.labelSource === 'human_reviewed') {
    if (Array.isArray(dataset)) throw new Error('Reviewed examples require validated review metadata.');
    validateReviewedDataset(dataset, cutoff);
  }
  const { train, test } = validateExamples(examples, cutoff);
  const model = trainFolderModel(train);
  const rule = (item) => suggestFolder(item.name, item.currentFolderId, item.folders)?.folderId || null;
  const learned = (item) => predictFolder(model, item);
  const baseline = measures(test, rule);
  const candidate = measures(test, learned);
  const baselineAbstentions = test.filter((item) => !rule(item));
  const byAccount = Object.fromEntries([...new Set(test.map((item) => item.accountId))]
    .sort().map((accountId) => {
      const rows = test.filter((item) => item.accountId === accountId);
      return [accountId, { baseline: measures(rows, rule), model: measures(rows, learned) }];
    }));
  const extensionOf = (name) => name.includes('.') ? name.split('.').at(-1).toLowerCase() : '(none)';
  const byExtension = Object.fromEntries([...new Set(test.map((item) => extensionOf(item.name)))]
    .sort().map((extension) => {
      const rows = test.filter((item) => extensionOf(item.name) === extension);
      return [extension, { baseline: measures(rows, rule), model: measures(rows, learned) }];
    }));
  return {
    cutoff, trainingExamples: train.length, testExamples: test.length,
    accounts: new Set(examples.map((item) => item.accountId)).size,
    labelSource: examples[0].labelSource,
    baseline, model: candidate,
    modelWhenRuleAbstains: measures(baselineAbstentions, learned),
    byAccount, byExtension,
    note: 'Exploratory comparison only; reviewed labels and prospective files are needed for a product claim.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , datasetPath, cutoff, detailFlag, ...extra] = process.argv;
  if (!datasetPath || !cutoff || extra.length || (detailFlag && detailFlag !== '--details')) {
    console.error('Usage: node scripts/evaluate-folder-suggestions.mjs DATASET.json YYYY-MM-DD [--details]');
    process.exitCode = 2;
  } else {
    try {
      const data = JSON.parse(await readFile(datasetPath, 'utf8'));
      const report = evaluateFolderSuggestions(data, cutoff);
      if (detailFlag !== '--details') {
        delete report.byAccount;
        delete report.byExtension;
      }
      console.log(JSON.stringify(report, null, 2));
    } catch {
      // Input paths and JSON parse errors can contain private filename data.
      console.error('Folder evaluation failed. Validate the dataset and cutoff locally.');
      process.exitCode = 1;
    }
  }
}
