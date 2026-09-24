import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ROOT_FOLDER_ID, routes } from '../../../../../packages/shared/index.js';
import { api } from '../../shared/lib/api.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { useStorage } from '../../shared/lib/useStorage.js';
import { StorageMeter } from '../../shared/components/StorageMeter.jsx';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function folderPath(folderId) {
  return `/v1/folders/${encodeURIComponent(folderId)}`;
}

function RowActions({ item, type, isOwner, confirmingId, setConfirmingId, deletingIds, deleteErrors, onDelete }) {
  if (!isOwner) return null;

  const isDeleting = deletingIds.has(item.id);
  const isConfirming = confirmingId === item.id;
  const err = deleteErrors[item.id];

  if (isDeleting) {
    return <div className="row-actions"><span className="muted">Deleting…</span></div>;
  }
  if (isConfirming) {
    return (
      <div className="row-actions">
        <span className="confirm-label">Delete "{item.name}"?</span>
        <button className="btn-danger" onClick={() => onDelete(type, item.id)}>Delete</button>
        <button className="btn-ghost" onClick={() => setConfirmingId(null)}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="row-actions">
      {err && <span className="error row-error" title={err}>{err}</span>}
      <button className="btn-ghost" onClick={() => setConfirmingId(item.id)}>Delete</button>
    </div>
  );
}

export function FilesPage() {
  const { id } = useParams();
  const location = useLocation();
  const folderId = id || ROOT_FOLDER_ID;

  const [listing, setListing] = useState(null);
  const [listError, setListError] = useState('');
  const [confirmingId, setConfirmingId] = useState(null);
  const [deletingIds, setDeletingIds] = useState(new Set());
  const [deleteErrors, setDeleteErrors] = useState({});

  const { user } = useAuth();
  const { usage, refreshUsage } = useStorage();

  const load = useCallback(() => {
    setListError('');
    api(routes.children(folderId))
      .then(setListing)
      .catch((caught) => setListError(caught.message));
  }, [folderId]);

  useEffect(() => {
    setListing(null);
    setConfirmingId(null);
    setDeleteErrors({});
    load();
  }, [load]);

  async function handleDelete(type, itemId) {
    const path = type === 'folder' ? folderPath(itemId) : routes.file(itemId);
    setDeletingIds((prev) => new Set([...prev, itemId]));
    setDeleteErrors((prev) => { const next = { ...prev }; delete next[itemId]; return next; });
    setConfirmingId(null);
    try {
      await api(path, { method: 'DELETE' });
      // Optimistically remove the item and refresh usage
      setListing((prev) => prev ? {
        ...prev,
        folders: prev.folders.filter((f) => f.id !== itemId),
        files: prev.files.filter((f) => f.id !== itemId),
      } : prev);
      refreshUsage();
    } catch (caught) {
      setDeleteErrors((prev) => ({ ...prev, [itemId]: caught.message }));
    } finally {
      setDeletingIds((prev) => { const next = new Set(prev); next.delete(itemId); return next; });
    }
  }

  const sharedProps = { confirmingId, setConfirmingId, deletingIds, deleteErrors, onDelete: handleDelete };
  const title = id ? location.state?.folderName || 'Folder' : 'My files';

  return (
    <section>
      {id && <Link to="/files">← My files</Link>}
      <h1>{title}</h1>
      <StorageMeter usage={usage} />
      {listError && <p className="error" role="alert">{listError}</p>}
      {!listing && !listError && <p>Loading files…</p>}
      {listing && (
        <div className="list" aria-label="Folder contents">
          {listing.folders.map((folder) => (
            <div className="row" key={folder.id}>
              <Link className="row-main" to={`/folders/${encodeURIComponent(folder.id)}`} state={{ folderName: folder.name }}>
                <span className="item-icon" aria-hidden="true">📁</span>
                <strong>{folder.name}</strong>
                <span className="muted">Folder</span>
              </Link>
              <RowActions item={folder} type="folder" isOwner={folder.ownerId === user?.id} {...sharedProps} />
            </div>
          ))}
          {listing.files.map((file) => (
            <div className="row" key={file.id}>
              <Link className="row-main" to={`/view/${encodeURIComponent(file.id)}`}>
                <span className="item-icon" aria-hidden="true">📄</span>
                <strong>{file.name}</strong>
                <span className="muted">{formatSize(file.size)}</span>
              </Link>
              <RowActions item={file} type="file" isOwner={file.ownerId === user?.id} {...sharedProps} />
            </div>
          ))}
          {!listing.folders.length && !listing.files.length && (
            <p className="empty">This folder is empty.</p>
          )}
        </div>
      )}
    </section>
  );
}
