import { useRef, useState } from 'react';
import { SUPPORTED_UPLOAD_TYPES, routes } from '../../../../../packages/shared/index.js';
import { validateUpload } from '../upload/UploadContext.jsx';

function sendFile(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', path);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', SUPPORTED_UPLOAD_TYPES[file.name.split('.').at(-1).toLowerCase()]);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    request.onload = () => {
      let body;
      try { body = JSON.parse(request.responseText); } catch { body = null; }
      if (request.status >= 200 && request.status < 300) resolve(body);
      else reject(new Error(body?.error?.message || `Upload failed (${request.status}).`));
    };
    request.onerror = () => reject(new Error('Cannot reach the API.'));
    request.send(file);
  });
}

export function WorkspaceUploader({ workspaceId, onDone }) {
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  async function submit(files) {
    const batch = Array.from(files).map((file, index) => ({ id: `${Date.now()}-${index}`,
      file, name: file.name, status: 'queued', progress: 0, error: validateUpload(file) }));
    if (!batch.length) return;
    setJobs((previous) => [...batch, ...previous]);
    setBusy(true);
    for (const job of batch) {
      if (job.error) {
        setJobs((previous) => previous.map((item) => item.id === job.id
          ? { ...item, status: 'failed' } : item));
        continue;
      }
      setJobs((previous) => previous.map((item) => item.id === job.id
        ? { ...item, status: 'uploading' } : item));
      try {
        await sendFile(routes.workspaceUpload(workspaceId, job.name), job.file, (progress) => {
          setJobs((previous) => previous.map((item) => item.id === job.id
            ? { ...item, progress } : item));
        });
        setJobs((previous) => previous.map((item) => item.id === job.id
          ? { ...item, status: 'success', progress: 100, file: null } : item));
        try { await onDone(); } catch { /* The upload succeeded; the next page refresh can retry the list. */ }
      } catch (error) {
        setJobs((previous) => previous.map((item) => item.id === job.id
          ? { ...item, status: 'failed', error: error.message } : item));
      }
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  }
  return <section className="workspace-card">
    <h2>Contribute files</h2>
    <p className="muted">Uploaded files belong to the workspace owner and use their storage quota. Successful files stay here if another upload fails.</p>
    <input ref={input} type="file" multiple disabled={busy} aria-label="Choose workspace files"
      onChange={(event) => void submit(event.target.files)} />
    {jobs.length > 0 && <ul>{jobs.map((job) => <li key={job.id}>{job.name}: {job.error || job.status}
      {job.status === 'uploading' && <progress value={job.progress} max="100" aria-label={`${job.name} progress`} />}
    </li>)}</ul>}
  </section>;
}

export function WorkspaceReplacement({ workspaceId, file, onDone }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const extension = file.name.split('.').at(-1).toLowerCase();
  async function replace(event) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    if (chosen.name.split('.').at(-1).toLowerCase() !== extension) {
      setError(`Choose a .${extension} file.`); return;
    }
    const problem = validateUpload(chosen);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(''); setProgress(0);
    try {
      await sendFile(routes.workspaceVersion(workspaceId, file.id), chosen, setProgress);
      await onDone();
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }
  return <span className="workspace-replacement">
    <label className="btn-ghost">New version<input className="visually-hidden" type="file"
      accept={`.${extension}`} disabled={busy} aria-label={`Replace ${file.name}`}
      onChange={(event) => void replace(event)} /></label>
    {busy && <progress value={progress} max="100" aria-label={`${file.name} replacement progress`} />}
    {error && <span className="error" role="alert">{error}</span>}
  </span>;
}
