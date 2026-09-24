import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ROOT_FOLDER_ID, routes } from '../../../../../packages/shared/index.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { UploadPanel } from '../upload/UploadPanel.jsx';
import { useUploads } from '../upload/UploadContext.jsx';
import { StorageMeter, formatBytes } from '../../shared/components/StorageMeter.jsx';
import { api } from '../../shared/lib/api.js';
import { useStorage } from '../../shared/lib/useStorage.js';

function ItemActions({ item, type, onDeleted }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    setPending(true);
    setError('');
    try {
      const path = type === 'file' ? routes.file(item.id) : `/v1/folders/${encodeURIComponent(item.id)}`;
      await api(path, { method: 'DELETE' });
      onDeleted(item.id);
    } catch (caught) {
      setError(caught.message);
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  return <div className="row-actions">
    {error && <span className="error" role="alert">{error}</span>}
    {confirming ? <>
      <span>Delete “{item.name}”?</span>
      <button type="button" className="btn-danger" disabled={pending} onClick={remove}>{pending ? 'Deleting…' : 'Delete'}</button>
      <button type="button" className="btn-ghost" disabled={pending} onClick={() => setConfirming(false)}>Cancel</button>
    </> : <button type="button" className="btn-ghost" onClick={() => setConfirming(true)}>Delete</button>}
  </div>;
}

export function FilesPage() {
  const { id } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const folderId = id || ROOT_FOLDER_ID;
  const { completedVersion } = useUploads();
  const { usage, error: usageError, refreshUsage } = useStorage();
  const [listing, setListing] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setListing(await api(routes.children(folderId)));
      setError('');
    } catch (caught) { setError(caught.message); }
  }, [folderId]);

  useEffect(() => {
    setListing(null);
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!completedVersion) return;
    void refresh();
    void refreshUsage();
  }, [completedVersion, refresh, refreshUsage]);

  function onDeleted(itemId) {
    setListing((previous) => previous && {
      ...previous,
      files: previous.files.filter((item) => item.id !== itemId),
      folders: previous.folders.filter((item) => item.id !== itemId),
    });
    void refreshUsage();
  }

  const title = id ? location.state?.folderName || 'Folder' : 'My files';
  return <section>
    {id && <Link to="/files">← My files</Link>}
    <h1>{title}</h1>
    <StorageMeter usage={usage} error={usageError} />
    <UploadPanel folderId={folderId} />
    {error && <p className="error" role="alert">{error}</p>}
    {!listing && !error && <p>Loading files…</p>}
    {listing && <div className="list" aria-label="Folder contents">
      {listing.folders.map((folder) => <div className="row" key={folder.id}>
        <Link className="row-main" to={`/folders/${encodeURIComponent(folder.id)}`} state={{ folderName: folder.name }}>
          <span className="item-icon" aria-hidden="true">📁</span><strong>{folder.name}</strong><span className="muted">Folder</span>
        </Link>
        {folder.ownerId === user.id && <ItemActions item={folder} type="folder" onDeleted={onDeleted} />}
      </div>)}
      {listing.files.map((file) => <div className="row" key={file.id}>
        <Link className="row-main" to={`/view/${encodeURIComponent(file.id)}`}>
          <span className="item-icon" aria-hidden="true">📄</span><strong>{file.name}</strong><span className="muted">{formatBytes(file.size)} · {file.ownerId === user.id ? 'Owned by you' : 'Shared with you'}</span>
        </Link>
        {file.ownerId === user.id && <ItemActions item={file} type="file" onDeleted={onDeleted} />}
      </div>)}
      {!listing.folders.length && !listing.files.length && <p className="empty">This folder is empty.</p>}
    </div>}
  </section>;
}
