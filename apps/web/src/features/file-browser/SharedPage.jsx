import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { routes } from '../../../../../packages/shared/index.js';
import { api } from '../../shared/lib/api.js';

export function SharedPage() {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api(routes.sharedFiles)
      .then((data) => { if (active) setFiles(data.files); })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, []);

  return <section>
    <h1>Shared with me</h1>
    <p className="muted">Files another account has granted you access to. You can view and download them.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {!files && !error && <p>Loading shared files…</p>}
    {files && <div className="list" aria-label="Shared files">
      {files.map((file) => <Link className="row" key={file.id} to={`/view/${encodeURIComponent(file.id)}`}>
        <span className="item-icon" aria-hidden="true">📄</span><strong>{file.name}</strong><span className="muted">View and download</span>
      </Link>)}
      {!files.length && <p className="empty">No files have been shared with you.</p>}
    </div>}
  </section>;
}
