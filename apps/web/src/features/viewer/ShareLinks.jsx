import { useEffect, useRef, useState } from 'react';
import { routes } from '../../../../../packages/shared/index.js';
import { api } from '../../shared/lib/api.js';

export function ShareLinks({ file }) {
  const dialog = useRef(null);
  const linkInput = useRef(null);
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState(null);
  const [created, setCreated] = useState(null);
  const [pending, setPending] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);
  const [error, setError] = useState('');
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    dialog.current.showModal();
    api(routes.shares(file.id))
      .then((result) => { if (active) setLinks(result.links); })
      .catch((caught) => { if (active) { setError(caught.message); setLinks([]); } });
    return () => { active = false; dialog.current?.close(); };
  }, [open, file.id]);

  function openDialog() {
    setLinks(null);
    setCreated(null);
    setConfirmingId(null);
    setError('');
    setCopyMessage('');
    setOpen(true);
  }

  function closeDialog() { dialog.current?.close(); }

  async function createLink() {
    setPending('create');
    setError('');
    setCopyMessage('');
    try {
      const share = await api(routes.shares(file.id), { method: 'POST' });
      const url = new URL(share.url, window.location.origin).href;
      setCreated({ id: share.id, url });
      setLinks((current) => [{ id: share.id, createdAt: new Date().toISOString(),
        expiresAt: share.expiresAt }, ...(current ?? [])]);
    } catch (caught) { setError(caught.message); }
    finally { setPending(null); }
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopyMessage('Link copied.');
    } catch {
      linkInput.current?.select();
      setCopyMessage('Copy is unavailable. Select and copy the link above.');
    }
  }

  async function revokeLink(shareId) {
    setPending(shareId);
    setError('');
    try {
      await api(routes.revokeShare(file.id, shareId), { method: 'DELETE' });
      setLinks((current) => current.filter((link) => link.id !== shareId));
      if (created?.id === shareId) { setCreated(null); setCopyMessage(''); }
      setConfirmingId(null);
    } catch (caught) { setError(caught.message); }
    finally { setPending(null); }
  }

  return <>
    <button type="button" className="btn-ghost" onClick={openDialog}>Share link</button>
    <dialog ref={dialog} className="upgrade-dialog share-link-dialog" aria-labelledby="share-link-title"
      onClose={() => { setOpen(false); setCreated(null); setCopyMessage(''); }}
      onCancel={(event) => { if (pending) event.preventDefault(); }}>
      <h2 id="share-link-title">Share a link to {file.name}</h2>
      <p>Anyone with a link can view or download the current file. Links expire after seven days. Revoke a link to stop access sooner.</p>
      <button type="button" disabled={Boolean(pending) || links === null} onClick={createLink}>Create link</button>
      {created && <div className="created-share-link">
        <label htmlFor="created-share-url">New link</label>
        <div className="share-link-copy">
          <input id="created-share-url" ref={linkInput} value={created.url} readOnly onFocus={(event) => event.target.select()} />
          <button type="button" className="btn-ghost" onClick={copyLink}>Copy link</button>
        </div>
        <p className="muted">Save this URL now. For security, it cannot be shown again after you close this dialog.</p>
        {copyMessage && <p role="status">{copyMessage}</p>}
      </div>}
      <h3>Existing links</h3>
      {links === null && <p>Loading links…</p>}
      {links?.length === 0 && !error && <p className="muted">No links for this file.</p>}
      {links?.length > 0 && <ul className="share-link-list">{links.map((link) => <li key={link.id}>
        <span>Created {new Date(link.createdAt).toLocaleString()} · Expires {new Date(link.expiresAt).toLocaleString()}</span>
        {confirmingId === link.id ? <span className="share-link-revoke">
          <span>Revoke this link?</span>
          <button type="button" className="btn-danger" disabled={Boolean(pending)} onClick={() => revokeLink(link.id)}>Revoke</button>
          <button type="button" className="btn-ghost" disabled={Boolean(pending)} onClick={() => setConfirmingId(null)}>Cancel</button>
        </span> : <button type="button" className="btn-ghost" disabled={Boolean(pending)}
          onClick={() => setConfirmingId(link.id)}>Revoke link</button>}
      </li>)}</ul>}
      {links?.length > 0 && <p className="muted">Existing URLs cannot be shown again. Create a new link if you lost one.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn-ghost" disabled={Boolean(pending)} onClick={closeDialog}>Done</button>
      </div>
    </dialog>
  </>;
}
