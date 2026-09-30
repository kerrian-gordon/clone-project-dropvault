import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { MAX_UPLOAD_BYTES, routes } from '../../../../../packages/shared/index.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { formatBytes } from '../../shared/components/StorageMeter.jsx';
import { api } from '../../shared/lib/api.js';
import { readTextPreview, TEXT_PREVIEW_MAX_BYTES } from './readTextPreview.js';
import { ShareLinks } from './ShareLinks.jsx';

const TEXT_MIME_TYPES = new Set(['text/plain', 'text/csv', 'application/json']);

function TextPreview({ src, size }) {
  const [text, setText] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(src, { credentials: 'same-origin', signal: controller.signal })
      .then(readTextPreview)
      .then((preview) => {
        if (!controller.signal.aborted) {
          setText(preview);
          setTruncated(size > TEXT_PREVIEW_MAX_BYTES);
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted && caught.name !== 'AbortError') {
          setError('Could not load text preview.');
        }
      });
    return () => controller.abort();
  }, [src, size]);

  if (error) return <p className="error">{error}</p>;
  if (text === null) return <p className="muted">Loading preview…</p>;
  return <>
    <pre className="preview-text">{text}</pre>
    {truncated && <p className="muted preview-truncated">Showing first 50 KiB — download for the full file.</p>}
  </>;
}

function canPreview(mimeType) {
  return mimeType.startsWith('image/')
    || mimeType === 'application/pdf'
    || mimeType === 'audio/mpeg'
    || mimeType === 'video/mp4'
    || TEXT_MIME_TYPES.has(mimeType);
}

function FilePreview({ file, src = routes.content(file.id) }) {
  const { mimeType } = file;

  if (mimeType.startsWith('image/')) {
    return <img src={src} alt={file.name} className="preview-image" />;
  }
  if (mimeType === 'application/pdf') {
    return <iframe src={src} title={file.name} className="preview-pdf" />;
  }
  if (mimeType === 'audio/mpeg') {
    return <audio controls src={src} className="preview-audio" />;
  }
  if (mimeType === 'video/mp4') {
    return <video controls src={src} className="preview-video" />;
  }
  if (TEXT_MIME_TYPES.has(mimeType)) {
    return <TextPreview src={src} size={file.size} />;
  }
  return null;
}

const MAX_COMPARE_LINES = 300;

function TextComparison({ file, version }) {
  const [texts, setTexts] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setTexts(null);
    setError('');
    const paths = [routes.versionContent(file.id, version.id), routes.content(file.id)];
    Promise.all(paths.map((path) => fetch(path, { credentials: 'same-origin', signal: controller.signal })
      .then(readTextPreview)))
      .then((result) => { if (!controller.signal.aborted) setTexts(result); })
      .catch((caught) => {
        if (!controller.signal.aborted && caught.name !== 'AbortError') setError('Could not compare these versions.');
      });
    return () => controller.abort();
  }, [file.id, file.currentVersionId, version.id]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!texts) return <p className="muted">Loading comparison…</p>;
  const [older, current] = texts.map((value) => value.split('\n').slice(0, MAX_COMPARE_LINES));
  const count = Math.max(older.length, current.length);
  return <div className="version-comparison">
    {[older, current].map((lines, side) => <div key={side}>
      <h4>{side ? 'Current' : 'Selected version'}</h4>
      <pre>{Array.from({ length: count }, (_, index) => {
        const changed = older[index] !== current[index];
        return <span key={index} className={changed ? 'changed-line' : ''}>{lines[index] || '\u00a0'}</span>;
      })}</pre>
    </div>)}
    {(version.size > TEXT_PREVIEW_MAX_BYTES || file.size > TEXT_PREVIEW_MAX_BYTES
      || count >= MAX_COMPARE_LINES) && <p className="muted">Comparison shows up to 50 KiB and 300 lines per version.</p>}
  </div>;
}

function uploadVersion(fileId, file, mimeType, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', routes.versions(fileId));
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', mimeType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    request.onload = () => {
      let body;
      try { body = JSON.parse(request.responseText); } catch { body = null; }
      if (request.status === 201) resolve(body);
      else {
        const error = new Error(body?.error?.message || `Upload failed (${request.status}).`);
        error.code = body?.error?.code;
        reject(error);
      }
    };
    request.onerror = () => reject(new Error('Cannot reach the API. Check your connection and try again.'));
    request.send(file);
  });
}

function VersionHistory({ file, onChanged }) {
  const { user, changePlan, demoPlanSwitchEnabled } = useAuth();
  const input = useRef(null);
  const [versions, setVersions] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const selected = versions?.find((version) => version.id === selectedId);
  const extension = file.name.split('.').at(-1).toLowerCase();

  const refresh = useCallback(async () => {
    const result = await api(routes.versions(file.id));
    setVersions(result.versions);
    setError('');
    setErrorCode('');
  }, [file.id]);

  useEffect(() => {
    let active = true;
    api(routes.versions(file.id))
      .then((result) => { if (active) setVersions(result.versions); })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [file.id, file.currentVersionId]);

  function showError(caught) { setError(caught.message); setErrorCode(caught.code || ''); }

  async function replace(event) {
    const replacement = event.target.files?.[0];
    event.target.value = '';
    if (!replacement) return;
    if (replacement.name.split('.').at(-1).toLowerCase() !== extension) {
      setError(`Choose a .${extension} file to keep this file's type.`);
      return;
    }
    if (replacement.size > MAX_UPLOAD_BYTES) {
      setError(`File exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 ** 2)} MiB upload limit.`);
      return;
    }
    setPending(true);
    setProgress(0);
    setError('');
    setErrorCode('');
    try {
      await uploadVersion(file.id, replacement, file.mimeType, setProgress);
      setSelectedId(null);
      setComparing(false);
      await onChanged();
      await refresh();
    } catch (caught) { showError(caught); }
    finally { setPending(false); setProgress(null); }
  }

  async function restore(versionId) {
    setPending(true);
    setError('');
    setErrorCode('');
    try {
      await api(routes.restoreVersion(file.id, versionId), { method: 'POST' });
      setSelectedId(null);
      setComparing(false);
      await onChanged();
      await refresh();
    } catch (caught) { showError(caught); }
    finally { setPending(false); }
  }

  async function saveLabel(event) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await api(routes.version(file.id, editingId), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      setEditingId(null);
      await refresh();
    } catch (caught) { showError(caught); }
    finally { setPending(false); }
  }

  async function upgrade() {
    setPending(true);
    try { await changePlan('demo'); setError(''); setErrorCode(''); }
    catch (caught) { showError(caught); }
    finally { setPending(false); }
  }

  return <section className="access-panel version-history" aria-label="Version history">
    <h2>Version history</h2>
    <p className="muted">Earlier versions stay until this file is deleted. Every version counts toward your storage usage. Restoring creates a new version, so you can undo a restore.</p>
    <button type="button" disabled={pending} onClick={() => input.current?.click()}>Upload new version</button>
    <input ref={input} className="visually-hidden" type="file" accept={`.${extension}`}
      aria-label={`Choose a .${extension} replacement`} onChange={replace} />
    {progress !== null && <progress max="100" value={progress} aria-label="New version upload progress" />}
    {error && <p className="error" role="alert">{error}</p>}
    {errorCode === 'STORAGE_CAP_EXCEEDED' && user.tier === 'free' && demoPlanSwitchEnabled && <button type="button"
      disabled={pending} onClick={upgrade}>Switch to demo plan</button>}
    {versions === null && !error && <p>Loading versions…</p>}
    {versions && <ol className="version-list">{versions.map((version) => <li key={version.id}>
      <div className="version-heading"><strong>{version.label || (version.id === file.currentVersionId ? 'Current version' : 'Unnamed version')}</strong>
        {version.id === file.currentVersionId && <span className="muted">Current</span>}</div>
      <p className="muted">{new Date(version.createdAt).toLocaleString()} · {formatBytes(version.size)} · {version.kind}</p>
      <div className="version-actions">
        <button type="button" className="btn-ghost" onClick={() => {
          setSelectedId(selectedId === version.id ? null : version.id); setComparing(false);
        }}>{selectedId === version.id ? 'Hide preview' : 'Preview'}</button>
        <a className="button-link" href={`${routes.versionContent(file.id, version.id)}?download=1`}>Download</a>
        <button type="button" className="btn-ghost" disabled={pending} onClick={() => {
          setEditingId(version.id); setLabel(version.label);
        }}>Name</button>
        {version.id !== file.currentVersionId && <button type="button" disabled={pending}
          onClick={() => restore(version.id)}>Restore as newest</button>}
      </div>
      {editingId === version.id && <form className="item-edit-form" onSubmit={saveLabel}>
        <label><span>Version name</span><input value={label} maxLength={80}
          onChange={(event) => setLabel(event.target.value)} disabled={pending} /></label>
        <button type="submit" disabled={pending}>Save name</button>
        <button type="button" className="btn-ghost" disabled={pending} onClick={() => setEditingId(null)}>Cancel</button>
      </form>}
    </li>)}</ol>}
    {selected && <div className="version-preview">
      <h3>{selected.label || 'Selected version'}</h3>
      {canPreview(selected.mimeType)
        ? <FilePreview file={{ ...file, name: selected.name, size: selected.size, mimeType: selected.mimeType }}
          src={routes.versionContent(file.id, selected.id)} />
        : <p className="muted">Preview not available for this file type.</p>}
      {selected.id !== file.currentVersionId && TEXT_MIME_TYPES.has(selected.mimeType) && <button
        type="button" className="btn-ghost" onClick={() => setComparing(!comparing)}>
        {comparing ? 'Hide comparison' : 'Compare with current'}
      </button>}
      {comparing && <TextComparison file={file} version={selected} />}
    </div>}
  </section>;
}

export function ViewerPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [grants, setGrants] = useState(null);
  const [accessError, setAccessError] = useState('');
  const [pending, setPending] = useState(false);
  const owned = file?.ownerId === user.id;

  const refreshFile = useCallback(async () => {
    setFile(await api(routes.file(id)));
  }, [id]);

  const refreshAccess = useCallback(async () => {
    try {
      const result = await api(routes.access(id));
      setGrants(result.users);
      setAccessError('');
    } catch (caught) { setAccessError(caught.message); }
  }, [id]);

  useEffect(() => {
    let active = true;
    setFile(null);
    setError('');
    setGrants(null);
    api(routes.file(id))
      .then((data) => { if (active) setFile(data); })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [id]);

  useEffect(() => { if (owned) void refreshAccess(); }, [owned, refreshAccess]);

  async function grant(event) {
    event.preventDefault();
    setPending(true);
    setAccessError('');
    const form = event.currentTarget;
    const email = new FormData(form).get('email');
    try {
      await api(routes.access(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      form.reset();
      await refreshAccess();
    } catch (caught) { setAccessError(caught.message); }
    finally { setPending(false); }
  }

  async function revoke(userId) {
    setPending(true);
    setAccessError('');
    try {
      await api(routes.revokeAccess(id, userId), { method: 'DELETE' });
      await refreshAccess();
    } catch (caught) { setAccessError(caught.message); }
    finally { setPending(false); }
  }

  return <section>
    <Link to={owned ? '/files' : '/shared'}>← {owned ? 'My files' : 'Shared with me'}</Link>
    {error && <p className="error" role="alert">{error}</p>}
    {!file && !error && <p>Loading file…</p>}
    {file && <>
      <h1>{file.name}</h1>
      <p className="muted">{file.mimeType} · {formatBytes(file.size)} · {owned ? 'Owned by you' : 'Shared with you'}</p>
      <p><strong>Your permission:</strong> {owned ? 'Owner — view, download, share and delete' : 'View and download'}</p>
      <div className="viewer-placeholder">
        {canPreview(file.mimeType)
          ? <FilePreview key={file.currentVersionId} file={file} />
          : <p className="muted">Preview not available for this file type.</p>}
        <a className="button-link" href={`${routes.content(id)}?download=1`} style={{ marginTop: '1.25rem', display: 'inline-block' }}>Download file</a>
        {owned && <ShareLinks key={file.id} file={file} />}
      </div>
      {owned && <VersionHistory file={file} onChanged={refreshFile} />}
      {owned && <section className="access-panel" aria-label="File access">
        <h2>Who has access</h2>
        <p><strong>{user.email}</strong> · Owner</p>
        {accessError && <p className="error" role="alert">{accessError}</p>}
        {grants === null && !accessError && <p>Loading access list…</p>}
        {grants?.length === 0 && <p className="muted">No other accounts have access.</p>}
        {grants?.length > 0 && <ul className="access-list">{grants.map((grant) => <li key={grant.userId}>
          <span>{grant.email} · View and download</span>
          <button type="button" className="btn-ghost" disabled={pending} onClick={() => revoke(grant.userId)}>Remove access</button>
        </li>)}</ul>}
        <form className="share-form" onSubmit={grant}>
          <label htmlFor="recipient-email">Share with an account</label>
          <input id="recipient-email" name="email" type="email" placeholder="person@example.com" required />
          <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Give access'}</button>
        </form>
      </section>}
    </>}
  </section>;
}
