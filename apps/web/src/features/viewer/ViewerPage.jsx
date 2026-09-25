import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '../../../../../packages/shared/index.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { formatBytes } from '../../shared/components/StorageMeter.jsx';
import { api } from '../../shared/lib/api.js';
import { readTextPreview, TEXT_PREVIEW_MAX_BYTES } from './readTextPreview.js';

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

function FilePreview({ file }) {
  const src = routes.content(file.id);
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

export function ViewerPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [grants, setGrants] = useState(null);
  const [accessError, setAccessError] = useState('');
  const [pending, setPending] = useState(false);
  const owned = file?.ownerId === user.id;

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
          ? <FilePreview file={file} />
          : <p className="muted">Preview not available for this file type.</p>}
        <a className="button-link" href={`${routes.content(id)}?download=1`} style={{ marginTop: '1.25rem', display: 'inline-block' }}>Download file</a>
      </div>
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
