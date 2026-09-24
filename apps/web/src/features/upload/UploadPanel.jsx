import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_UPLOAD_TYPES } from '../../../../../packages/shared/index.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { formatBytes } from '../../shared/components/StorageMeter.jsx';
import { useUploads } from './UploadContext.jsx';

export function UploadPanel({ folderId, usage, refreshUsage }) {
  const { jobs, enqueue, retry } = useUploads();
  const { user, changePlan } = useAuth();
  const input = useRef(null);
  const upgradeDialog = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [upgradeJobId, setUpgradeJobId] = useState(null);
  const [upgradePending, setUpgradePending] = useState(false);
  const [upgradeError, setUpgradeError] = useState('');
  const accept = Object.keys(SUPPORTED_UPLOAD_TYPES).map((extension) => `.${extension}`).join(',');
  const blockedJob = jobs.find((job) => job.id === upgradeJobId);
  const cappedJobs = jobs.filter((job) => job.folderId === folderId && job.status === 'failed'
    && job.code === 'STORAGE_CAP_EXCEEDED');
  const freeLimit = usage?.tier === 'demo' ? usage.limitBytes / 10 : usage?.limitBytes;
  const demoHasSpace = !usage || !blockedJob || usage.usedBytes + blockedJob.size <= freeLimit * 10;

  useEffect(() => {
    const dialog = upgradeDialog.current;
    if (upgradeJobId !== null && !dialog.open) dialog.showModal();
    if (upgradeJobId === null && dialog.open) dialog.close();
  }, [upgradeJobId]);

  function closeUpgrade() {
    upgradeDialog.current?.close();
    setUpgradeJobId(null);
    setUpgradeError('');
  }

  async function upgradeAndRetry() {
    if (!blockedJob || upgradePending) return;
    setUpgradePending(true);
    setUpgradeError('');
    try {
      await changePlan('demo');
      const latest = await refreshUsage();
      if (!latest || latest.tier !== 'demo') {
        setUpgradeError('Your plan changed, but the new storage allowance could not be confirmed. Close this prompt and retry the upload.');
        return;
      }
      if (latest.usedBytes + blockedJob.size > latest.limitBytes) {
        setUpgradeError('The demo plan still does not have enough space for this file. Delete files to free space, then retry.');
        return;
      }
      let availableBytes = latest.limitBytes - latest.usedBytes;
      for (const job of [blockedJob, ...cappedJobs.filter((item) => item.id !== blockedJob.id)]) {
        if (job.size <= availableBytes) {
          retry(job.id);
          availableBytes -= job.size;
        }
      }
      closeUpgrade();
    } catch (caught) {
      setUpgradeError(caught.message);
    } finally {
      setUpgradePending(false);
    }
  }

  function addFiles(files) { enqueue(files, folderId); setDragging(false); }
  function onDrop(event) { event.preventDefault(); addFiles(event.dataTransfer.files); }
  const visibleJobs = jobs.filter((job) => job.folderId === folderId);

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
    {visibleJobs.length > 0 && <div className="upload-queue" aria-label="Upload queue">
      <h2>Uploads</h2>
      <ul>{visibleJobs.map((job) => <li key={job.id}>
        <div className="upload-job-heading"><strong>{job.name}</strong><span>{formatBytes(job.size)}</span></div>
        {job.status === 'uploading' && <progress max="100" value={job.progress} aria-label={`${job.name} upload progress`} />}
        <p className={job.status === 'failed' ? 'error' : 'muted'} role={job.status === 'failed' ? 'alert' : undefined}>
          {job.status === 'failed' ? job.error : job.status === 'success' ? 'Uploaded' : job.status === 'queued' ? 'Waiting' : `${job.progress}% uploaded`}
        </p>
        {job.status === 'failed' && job.code !== 'CLIENT_VALIDATION' && <button type="button" className="btn-ghost" onClick={() => retry(job.id)}>Retry</button>}
        {job.code === 'STORAGE_CAP_EXCEEDED' && <div className="cap-actions">
          <p className="muted">This file stays in the queue until you refresh or log out. {user.tier === 'free' ? 'Free space and retry, or switch to the demo plan.' : 'Free space, then retry.'}</p>
          {user.tier === 'free' && <button type="button" onClick={() => { setUpgradeError(''); setUpgradeJobId(job.id); }}>Upgrade storage</button>}
        </div>}
      </li>)}</ul>
    </div>}
    <dialog ref={upgradeDialog} className="upgrade-dialog" aria-labelledby="upgrade-title"
      onClose={() => setUpgradeJobId(null)} onCancel={(event) => { if (upgradePending) event.preventDefault(); }}>
      <h2 id="upgrade-title">Upgrade storage</h2>
      <p><strong>{blockedJob?.name}</strong> could not upload because it would exceed your storage limit.</p>
      <p>The demo plan provides ten times the free storage limit. This prototype switch has no payment step. This file and other blocked files that fit will retry after the new limit is confirmed.</p>
      {freeLimit != null && <p className="muted">Free limit: {formatBytes(freeLimit)}. Demo limit: {formatBytes(freeLimit * 10)}.</p>}
      {!demoHasSpace && <p className="error" role="alert">Even the demo plan does not have enough space for this file. Delete files to free space.</p>}
      {upgradeError && <p className="error" role="alert">{upgradeError}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn-ghost" disabled={upgradePending} onClick={closeUpgrade}>Cancel</button>
        {user.tier === 'free' && <button type="button" disabled={upgradePending || !demoHasSpace} onClick={upgradeAndRetry}>
          {upgradePending ? 'Upgrading…' : 'Switch to demo and retry'}
        </button>}
      </div>
    </dialog>
  </section>;
}
