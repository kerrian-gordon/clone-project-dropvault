import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ROOT_FOLDER_ID, routes } from '../../../../../packages/shared/index.js';
import { api } from '../../shared/lib/api.js';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function FilesPage() {
  const { id } = useParams();
  const location = useLocation();
  const folderId = id || ROOT_FOLDER_ID;
  const [listing, setListing] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setListing(null);
    setError('');
    api(routes.children(folderId))
      .then((data) => { if (active) setListing(data); })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [folderId]);

  const title = id ? location.state?.folderName || 'Folder' : 'My files';
  return (
    <section>
      {id && <Link to="/files">← My files</Link>}
      <h1>{title}</h1>
      <p className="muted">Select a folder to browse it or a file to open its viewer.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!listing && !error && <p>Loading files…</p>}
      {listing && (
        <div className="list" aria-label="Folder contents">
          {listing.folders.map((folder) => (
            <Link className="row" key={folder.id} to={`/folders/${encodeURIComponent(folder.id)}`} state={{ folderName: folder.name }}>
              <span className="item-icon" aria-hidden="true">📁</span><strong>{folder.name}</strong><span className="muted">Folder</span>
            </Link>
          ))}
          {listing.files.map((file) => (
            <Link className="row" key={file.id} to={`/view/${encodeURIComponent(file.id)}`}>
              <span className="item-icon" aria-hidden="true">📄</span><strong>{file.name}</strong><span className="muted">{formatSize(file.size)}</span>
            </Link>
          ))}
          {!listing.folders.length && !listing.files.length && <p className="empty">This folder is empty.</p>}
        </div>
      )}
    </section>
  );
}
