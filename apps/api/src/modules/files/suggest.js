import { ROOT_FOLDER_ID } from '../../../../../packages/shared/index.js';

const TYPE_FOLDERS = Object.freeze({
  pdf: ['documents'], docx: ['documents'], pptx: ['documents'], xlsx: ['documents'],
  txt: ['documents'], csv: ['documents'], json: ['documents'],
  png: ['photos', 'images'], jpg: ['photos', 'images'], jpeg: ['photos', 'images'],
  gif: ['photos', 'images'], webp: ['photos', 'images'],
  mp3: ['audio', 'music'], mp4: ['videos'],
  zip: ['archives'], gz: ['archives'],
});

function words(value) {
  return value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3)
    .map((word) => word.length > 4 && word.endsWith('s') && !word.endsWith('ss')
      ? word.slice(0, -1) : word);
}

/** Return one clear match among the account's existing folders, or abstain. */
export function suggestFolder(name, currentFolderId, folders) {
  const stem = name.replace(/\.[^.]+$/u, '');
  const fileWords = new Set(words(stem));
  const extension = name.split('.').at(-1)?.toLowerCase();
  const candidates = folders.map((folder) => {
    const folderWords = [...new Set(words(folder.name))];
    const nameMatch = folderWords.length > 0 && folderWords.every((word) => fileWords.has(word));
    const typeMatch = (TYPE_FOLDERS[extension] || []).includes(folder.name.toLowerCase());
    return { folder, score: nameMatch ? 100 + folderWords.length : typeMatch ? 10 : 0,
      rule: nameMatch ? 'name_match' : typeMatch ? 'type_match' : null };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!candidates.length || candidates[0].folder.id === currentFolderId
    || (candidates[1] && candidates[0].score === candidates[1].score)) return null;
  const winner = candidates[0];
  if (winner.folder.id === ROOT_FOLDER_ID) return null;
  return { folderId: winner.folder.id, folderName: winner.folder.name, rule: winner.rule,
    reason: winner.rule === 'name_match' ? 'Folder name matches the file name'
      : 'Folder name matches the file type' };
}
