import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { MAX_NAME_LENGTH, MAX_UPLOAD_BYTES, SUPPORTED_UPLOAD_TYPES, routes, validName } from '../../../../../packages/shared/index.js';

const UploadContext = createContext(null);
const extensionOf = (name) => name.split('.').at(-1)?.toLowerCase();

export function validateUpload(file) {
  if (!validName(file.name) || file.name.length > MAX_NAME_LENGTH) return 'File name is invalid.';
  if (!Object.hasOwn(SUPPORTED_UPLOAD_TYPES, extensionOf(file.name))) return 'Unsupported file type.';
  if (file.size > MAX_UPLOAD_BYTES) return `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 2)} MiB upload limit.`;
  return '';
}

function upload(file, folderId, onProgress, onRequest) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    onRequest(request);
    request.open('POST', `${routes.files}?name=${encodeURIComponent(file.name)}&folderId=${encodeURIComponent(folderId)}`);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', SUPPORTED_UPLOAD_TYPES[extensionOf(file.name)]);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    request.onload = () => {
      let body;
      try { body = JSON.parse(request.responseText); } catch { body = null; }
      if (request.status >= 200 && request.status < 300) resolve(body);
      else {
        const error = new Error(body?.error?.message || `Upload failed (${request.status}).`);
        error.code = body?.error?.code;
        reject(error);
      }
    };
    request.onerror = () => reject(new Error('Cannot reach the API. Check your connection and try again.'));
    request.onabort = () => reject(new Error('Upload canceled.'));
    request.send(file);
  });
}

export function UploadProvider({ children }) {
  const [jobs, setJobs] = useState([]);
  const [completedVersion, setCompletedVersion] = useState(0);
  const queue = useRef([]);
  const processing = useRef(false);
  const currentRequest = useRef(null);
  const nextId = useRef(0);

  const update = useCallback((id, change) => {
    setJobs((previous) => previous.map((job) => job.id === id ? { ...job, ...change } : job));
  }, []);

  const processQueue = useCallback(async () => {
    if (processing.current) return;
    processing.current = true;
    while (queue.current.length) {
      const job = queue.current.shift();
      update(job.id, { status: 'uploading', progress: 0 });
      try {
        await upload(job.file, job.folderId, (progress) => update(job.id, { progress }),
          (request) => { currentRequest.current = request; });
        update(job.id, { status: 'success', progress: 100, file: null });
        setCompletedVersion((version) => version + 1);
      } catch (error) {
        update(job.id, { status: 'failed', error: error.message, code: error.code });
      } finally {
        currentRequest.current = null;
      }
    }
    processing.current = false;
  }, [update]);

  const enqueue = useCallback((files, folderId) => {
    const incoming = Array.from(files, (file) => {
      const error = validateUpload(file);
      return { id: ++nextId.current, file, name: file.name, size: file.size, folderId,
        status: error ? 'failed' : 'queued', progress: 0, error, code: error ? 'CLIENT_VALIDATION' : '' };
    });
    if (!incoming.length) return;
    setJobs((previous) => [...incoming, ...previous]);
    queue.current.push(...incoming.filter((job) => !job.error));
    void processQueue();
  }, [processQueue]);

  const retry = useCallback((id) => {
    const job = jobs.find((item) => item.id === id);
    if (!job || job.status !== 'failed' || job.code === 'CLIENT_VALIDATION') return;
    update(id, { status: 'queued', progress: 0, error: '', code: '' });
    queue.current.push(job);
    void processQueue();
  }, [jobs, processQueue, update]);

  useEffect(() => () => { currentRequest.current?.abort(); queue.current = []; }, []);
  return <UploadContext.Provider value={{ jobs, enqueue, retry, completedVersion }}>{children}</UploadContext.Provider>;
}

export function useUploads() { return useContext(UploadContext); }
