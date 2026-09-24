import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '../../../../../packages/shared/index.js';
import { api } from '../../shared/lib/api.js';

export function ViewerPage() {
  const { id } = useParams();
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setFile(null);
    setError('');
    api(routes.file(id))
      .then((data) => { if (active) setFile(data); })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [id]);

  return (
    <section>
      <Link to="/files">← My files</Link>
      {error && <p className="error" role="alert">{error}</p>}
      {!file && !error && <p>Loading file…</p>}
      {file && <>
        <h1>{file.name}</h1>
        <p className="muted">{file.mimeType} · {file.size.toLocaleString()} bytes</p>
        <div className="viewer-placeholder">
          <h2>Preview</h2>
          <p>Inline preview is coming in the viewing feature. You can download this file now.</p>
          <a className="button-link" href={`${routes.content(id)}?download=1`}>Download file</a>
        </div>
      </>}
    </section>
  );
}
