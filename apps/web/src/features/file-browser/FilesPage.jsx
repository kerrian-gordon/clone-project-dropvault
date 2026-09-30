import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ROOT_FOLDER_ID, routes } from '../../../../../packages/shared/index.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { UploadPanel } from '../upload/UploadPanel.jsx';
import { useUploads } from '../upload/UploadContext.jsx';
import { formatBytes } from '../../shared/components/StorageMeter.jsx';
import { api } from '../../shared/lib/api.js';
import { useStorage } from '../../shared/lib/useStorage.jsx';

function folderPath(folder, byId) {
  const names = [folder.name];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId !== ROOT_FOLDER_ID && byId.has(parentId) && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    names.unshift(parent.name);
    seen.add(parentId);
    parentId = parent.parentId;
  }
  return `My files / ${names.join(' / ')}`;
}

function ItemActions({ item, type, onDeleted, onChanged }) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [folders, setFolders] = useState(null);
  const [name, setName] = useState(item.name);
  const [destination, setDestination] = useState(type === 'file' ? item.folderId : item.parentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function openEditor() {
    setConfirming(false);
    setEditing(true);
    setName(item.name);
    setDestination(type === 'file' ? item.folderId : item.parentId);
    setFolders(null);
    setError('');
    try {
      const result = await api(routes.folders);
      setFolders(result.folders);
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function save(event) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      const path = type === 'file' ? routes.file(item.id) : routes.folder(item.id);
      const body = type === 'file' ? { name, folderId: destination } : { name, parentId: destination };
      await api(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      setEditing(false);
      void onChanged();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    setError('');
    try {
      const path = type === 'file' ? routes.file(item.id) : routes.folder(item.id);
      await api(path, { method: 'DELETE' });
      onDeleted(item.id);
    } catch (caught) {
      setError(caught.message);
      setConfirming(false);
    } finally {
      setPending(false);
    }
  }

  const byId = new Map((folders || []).map((folder) => [folder.id, folder]));
  function availableDestination(folder) {
    if (type === 'file') return true;
    const seen = new Set();
    let current = folder;
    while (current && !seen.has(current.id)) {
      if (current.id === item.id) return false;
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return true;
  }

  return <div className="row-actions">
    {error && <span className="error" role="alert">{error}</span>}
    {editing ? <form className="item-edit-form" onSubmit={save}>
      <label>
        <span>Name</span>
        <input value={name} maxLength={255} onChange={(event) => setName(event.target.value)}
          disabled={pending || !folders} required />
      </label>
      <label>
        <span>Move to</span>
        <select value={destination} onChange={(event) => setDestination(event.target.value)}
          disabled={pending || !folders}>
          <option value={ROOT_FOLDER_ID}>My files</option>
          {(folders || []).filter(availableDestination).map((folder) =>
            <option key={folder.id} value={folder.id}>{folderPath(folder, byId)}</option>)}
        </select>
      </label>
      <button type="submit" disabled={pending || !folders}>{pending ? 'Saving...' : 'Save'}</button>
      <button type="button" className="btn-ghost" disabled={pending}
        onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
      {type === 'file' && <span className="muted">Keep the file extension unchanged.</span>}
    </form> : confirming ? <>
      <span>Delete “{item.name}”?</span>
      <button type="button" className="btn-danger" disabled={pending} aria-busy={pending} onClick={remove}>{pending ? 'Deleting…' : 'Delete'}</button>
      <button type="button" className="btn-ghost" disabled={pending} onClick={() => setConfirming(false)}>Cancel</button>
    </> : <>
      <button type="button" className="btn-ghost" onClick={openEditor}>Rename or move</button>
      <button type="button" className="btn-ghost" onClick={() => setConfirming(true)}>Delete</button>
    </>}
  </div>;
}

export function FilesPage() {
  const { id } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const folderId = id || ROOT_FOLDER_ID;
  const { completedVersion } = useUploads();
  const { usage, refreshUsage } = useStorage();
  const [listing, setListing] = useState(null);
  const [error, setError] = useState('');
  const [stats, setStats] = useState(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderPending, setFolderPending] = useState(false);
  const [folderError, setFolderError] = useState('');
  const refreshVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const latest = await api(routes.children(folderId));
      if (version === refreshVersion.current) {
        setListing(latest);
        setError('');
      }
    } catch (caught) {
      if (version === refreshVersion.current) setError(caught.message);
    }
  }, [folderId]);

  useEffect(() => {
    setListing(null);
    void refresh();
    return () => { refreshVersion.current += 1; };
  }, [refresh]);
  useEffect(() => {
    let active = true;
    api(routes.organizationStats)
      .then((result) => { if (active) setStats(result); })
      .catch(() => { if (active) setStats(null); });
    return () => { active = false; };
  }, [completedVersion]);
  useEffect(() => {
    if (!completedVersion) return;
    void refresh();
    void refreshUsage();
  }, [completedVersion, refresh, refreshUsage]);

  function onDeleted(itemId) {
    refreshVersion.current += 1;
    setListing((previous) => previous && {
      ...previous,
      files: previous.files.filter((item) => item.id !== itemId),
      folders: previous.folders.filter((item) => item.id !== itemId),
    });
    void refreshUsage();
  }

  async function createFolder(event) {
    event.preventDefault();
    setFolderPending(true);
    setFolderError('');
    try {
      await api(routes.folders, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newFolderName, parentId: folderId }),
      });
      setCreatingFolder(false);
      setNewFolderName('');
      await refresh();
    } catch (caught) {
      setFolderError(caught.message);
    } finally {
      setFolderPending(false);
    }
  }

  const title = id ? location.state?.folderName || 'Folder' : 'My files';
  const query = (new URLSearchParams(location.search).get('q') || '').trim().toLowerCase();
  const folders = listing?.folders.filter((folder) => !query || folder.name.toLowerCase().includes(query)) || [];
  const files = listing?.files.filter((file) => !query || file.name.toLowerCase().includes(query)) || [];
  return <section>
    {id && <Link to="/files">← My files</Link>}
    <h1>{title}</h1>
    {stats && stats.shown > 0 && <p className="muted">Folder suggestions: {stats.shown} shown · {stats.accepted} used · {stats.keptCurrent} kept here.</p>}
    {creatingFolder ? <form className="item-edit-form" onSubmit={createFolder}>
      <label><span>Folder name</span><input autoFocus value={newFolderName} maxLength={255}
        onChange={(event) => setNewFolderName(event.target.value)} disabled={folderPending} required /></label>
      <button type="submit" disabled={folderPending}>{folderPending ? 'Creating…' : 'Create folder'}</button>
      <button type="button" className="btn-ghost" disabled={folderPending}
        onClick={() => { setCreatingFolder(false); setFolderError(''); setNewFolderName(''); }}>Cancel</button>
      {folderError && <span className="error" role="alert">{folderError}</span>}
    </form> : <button type="button" className="btn-ghost" onClick={() => setCreatingFolder(true)}>New folder</button>}
    <UploadPanel folderId={folderId} usage={usage} refreshUsage={refreshUsage} />
    {error && <p className="error" role="alert">{error}</p>}
    {!listing && !error && <p>Loading files…</p>}
    {listing && <div className="list" aria-label="Folder contents">
      {folders.map((folder) => <div className="row" key={folder.id}>
        <Link className="row-main" to={`/folders/${encodeURIComponent(folder.id)}`} state={{ folderName: folder.name }}>
          <span className="item-icon" aria-hidden="true">📁</span><strong>{folder.name}</strong><span className="muted">Folder</span>
        </Link>
        {folder.ownerId === user.id && <ItemActions item={folder} type="folder" onDeleted={onDeleted} onChanged={refresh} />}
      </div>)}
      {files.map((file) => <div className="row" key={file.id}>
        <Link className="row-main" to={`/view/${encodeURIComponent(file.id)}`}>
          <span className="item-icon" aria-hidden="true">📄</span><strong>{file.name}</strong><span className="muted">{formatBytes(file.size)} · {file.ownerId === user.id ? 'Owned by you' : 'Shared with you'}</span>
        </Link>
        {file.ownerId === user.id && <ItemActions item={file} type="file" onDeleted={onDeleted} onChanged={refresh} />}
      </div>)}
      {!folders.length && !files.length && <p className="empty">{query
        ? 'No files or folders match that search.'
        : 'This folder is empty.'}</p>}
    </div>}
  </section>;
}
