import { useRef, useState } from 'react';
import { routes, SUPPORTED_UPLOAD_TYPES } from '../../../../../packages/shared/index.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { formatBytes } from '../../shared/components/StorageMeter.jsx';
import { api } from '../../shared/lib/api.js';
import { useUploads } from './UploadContext.jsx';

export function UploadPanel({ folderId }) {
  const { jobs, enqueue, retry } = useUploads();
  const { user, refreshUser } = useAuth();
  const input = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState('');
  const accept = Object.keys(SUPPORTED_UPLOAD_TYPES).map((extension) => `.${extension}`).join(',');

  function addFiles(files) { enqueue(files, folderId); setDragging(false); }
  function onDrop(event) { event.preventDefault(); addFiles(event.dataTransfer.files); }
  const visibleJobs = jobs.filter((job) => job.folderId === folderId);
  const cappedJobs = visibleJobs.filter((job) => job.code === 'STORAGE_CAP_EXCEEDED');
  const showUpgrade = cappedJobs.length > 0 && user?.tier === 'free';

  async function handleUpgrade() {
    setUpgrading(true);
    setUpgradeError('');
    try {
      await api(routes.plan, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'demo' }),
      });
      await refreshUser();
      cappedJobs.forEach((job) => retry(job.id));
    } catch (caught) {
      setUpgradeError(caught.message);
    } finally {
      setUpgrading(false);
    }
  }

  return <section className="upload-panel" aria-label="Upload files">
    <div className={`drop-zone${dragging ? ' dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop={onDrop}>
      <p><strong>Drop files here</strong> or choose them from your device.</p>
      <button type="button" onClick={() => input.current?.click()}>Choose files</button>
      <input ref={input} className="visually-hidden" type="file" multiple accept={accept}
        aria-label="Choose files to upload" onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
      <p className="muted">PDF, Office documents, text, images, audio, video and archives · 100 MiB per file</p>
    </div>
    {showUpgrade && <div className="upgrade-banner" role="alert">
      <div className="upgrade-banner-body">
        <strong>Your free storage is full.</strong>
        <p>Upgrade to the Demo plan (10 GiB) to keep uploading. Your {cappedJobs.length === 1 ? 'file' : `${cappedJobs.length} files`} will retry automatically.</p>
        {upgradeError && <p className="error">{upgradeError}</p>}
      </div>
      <button type="button" disabled={upgrading} onClick={handleUpgrade}>
        {upgrading ? 'Upgrading…' : 'Upgrade to Demo'}
      </button>
    </div>}
    {visibleJobs.length > 0 && <div className="upload-queue" aria-label="Upload queue">
      <h2>Uploads</h2>
      <ul>{visibleJobs.map((job) => <li key={job.id}>
        <div className="upload-job-heading"><strong>{job.name}</strong><span>{formatBytes(job.size)}</span></div>
        {job.status === 'uploading' && <progress max="100" value={job.progress} aria-label={`${job.name} upload progress`} />}
        <p className={job.status === 'failed' ? 'error' : 'muted'} role={job.status === 'failed' ? 'alert' : undefined}>
          {job.status === 'failed' ? job.error : job.status === 'success' ? 'Uploaded' : job.status === 'queued' ? 'Waiting' : `${job.progress}% uploaded`}
        </p>
        {job.status === 'failed' && job.code !== 'CLIENT_VALIDATION' && job.code !== 'STORAGE_CAP_EXCEEDED' && (
          <button type="button" className="btn-ghost" onClick={() => retry(job.id)}>Retry</button>
        )}
      </li>)}</ul>
    </div>}
  </section>;
}
