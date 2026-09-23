import { MAX_UPLOAD_BYTES, ROOT_FOLDER_ID, normalizeMimeType, validName } from '../../../../../packages/shared/index.js';
import { ApiError } from '../../routes/errors.js';

export function uploadDetails(request, url, catalog, maxUploadBytes = MAX_UPLOAD_BYTES) {
  const name = url.searchParams.get('name');
  const folderId = url.searchParams.get('folderId') || ROOT_FOLDER_ID;
  if (!validName(name)) throw new ApiError(400, 'INVALID_NAME', 'Provide a valid file name');
  catalog.listChildren(folderId);
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > maxUploadBytes) {
    throw new ApiError(413, 'FILE_TOO_LARGE', 'File exceeds the upload limit');
  }
  return { name, folderId, mimeType: normalizeMimeType(request.headers['content-type']) };
}
