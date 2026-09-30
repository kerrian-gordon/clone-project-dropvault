import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { routes } from '../../../../../packages/shared/index.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { useUploads } from '../upload/UploadContext.jsx';
import { formatBytes } from '../../shared/components/StorageMeter.jsx';
import { api } from '../../shared/lib/api.js';
import { WorkspaceUploader, WorkspaceReplacement } from './WorkspaceUploader.jsx';

const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body) });
const openableTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif',
  'image/webp', 'text/plain', 'audio/mpeg', 'video/mp4']);

export function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState(null);
  const [shared, setShared] = useState([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    Promise.all([api(routes.workspaces), api(routes.sharedSnapshots)])
      .then(([mine, other]) => { if (active) { setWorkspaces(mine.workspaces); setShared(other.snapshots); } })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, []);
  async function create(event) {
    event.preventDefault();
    setPending(true); setError('');
    try {
      const workspace = await api(routes.workspaces, jsonOptions('POST', { name, description }));
      navigate(`/workspaces/${workspace.id}`);
    } catch (caught) { setError(caught.message); }
    finally { setPending(false); }
  }
  return <section className="workspace-page">
    <h1>Workspaces</h1>
    <p className="muted">Collect files for a project, then save exact versions in a snapshot.</p>
    <form className="workspace-card workspace-form" onSubmit={create}>
      <h2>New workspace</h2>
      <label>Name<input value={name} maxLength={255} required onChange={(event) => setName(event.target.value)} /></label>
      <label>Description<textarea value={description} maxLength={1000}
        onChange={(event) => setDescription(event.target.value)} /></label>
      <button disabled={pending}>{pending ? 'Creating…' : 'Create workspace'}</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <h2>Workspaces I can access</h2>
    {workspaces === null ? <p>Loading…</p> : workspaces.length ? <div className="list">
      {workspaces.map((workspace) => <div className="row" key={workspace.id}>
        <Link className="row-main" to={`/workspaces/${workspace.id}`}><strong>{workspace.name}</strong>
          <span className="muted">{workspace.fileIds.length} files · {workspace.role}</span></Link>
      </div>)}
    </div> : <p className="muted">No workspaces yet.</p>}
    <h2>Snapshots shared with me</h2>
    {shared.length ? <div className="list">{shared.map((snapshot) => <div className="row" key={snapshot.id}>
      <Link className="row-main" to={`/snapshots/${snapshot.id}`}><strong>{snapshot.name}</strong>
        <span className="muted">{snapshot.items.length} files</span></Link>
    </div>)}</div> : <p className="muted">No snapshots shared with you.</p>}
  </section>;
}

export function WorkspacePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { jobs, completedVersion } = useUploads();
  const [workspace, setWorkspace] = useState(null);
  const [files, setFiles] = useState([]);
  const [owned, setOwned] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [addId, setAddId] = useState('');
  const [selected, setSelected] = useState([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [reviewedItems, setReviewedItems] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [members, setMembers] = useState([]);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState('viewer');
  const [gitFileId, setGitFileId] = useState('');
  const uploadsPending = jobs.some((job) => ['checking', 'suggested', 'queued', 'uploading'].includes(job.status));
  const refresh = useCallback(async () => {
    const [project, members, all, saved] = await Promise.all([
      api(routes.workspace(id)), api(routes.workspaceFiles(id)), api(routes.ownedFiles), api(routes.snapshots(id)),
    ]);
    setWorkspace(project); setFiles(members.files); setOwned(all.files); setSnapshots(saved.snapshots);
    setSelected((previous) => {
      const current = previous.filter((fileId) => members.files.some((file) => file.id === fileId));
      if (project.git && members.files.some((file) => file.id === project.git.archiveFileId)
        && !current.includes(project.git.archiveFileId)) current.push(project.git.archiveFileId);
      return current;
    });
    if (project.role === 'owner') setMembers((await api(routes.workspaceAccess(id))).users);
  }, [id]);
  useEffect(() => {
    let active = true;
    refresh().catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [refresh, completedVersion]);
  async function change(action) {
    setPending(true); setError('');
    try { await action(); await refresh(); }
    catch (caught) { setError(caught.message); }
    finally { setPending(false); }
  }
  const available = owned.filter((file) => !files.some((member) => member.id === file.id));
  const chosen = files.filter((file) => selected.includes(file.id));
  const reviewing = reviewedItems !== null;
  const isOwner = workspace?.role === 'owner';
  const canContribute = isOwner || workspace?.role === 'contributor';
  const linkedArchiveStale = workspace?.git && files.some((file) =>
    file.id === workspace.git.archiveFileId && file.currentVersionId !== workspace.git.archiveVersionId);
  async function createSnapshot() {
    await change(async () => {
      try {
        const snapshot = await api(routes.snapshots(id), jsonOptions('POST', { name, note,
          fileIds: reviewedItems.map((file) => file.id),
          expectedVersions: reviewedItems.map((file) =>
            ({ fileId: file.id, versionId: file.currentVersionId })) }));
        navigate(`/snapshots/${snapshot.id}`);
      } catch (caught) {
        if (['SNAPSHOT_FILES_CHANGED', 'GIT_ARCHIVE_CHANGED'].includes(caught.code)) {
          setReviewedItems(null);
          await refresh().catch(() => {});
        }
        throw caught;
      }
    });
  }
  return <section className="workspace-page">
    <Link to="/workspaces">← Workspaces</Link>
    {workspace ? <><h1>{workspace.name}</h1><p>{workspace.description || 'No description.'}</p>
      <p className="muted">Your role: {workspace.role}. Workspace uploads use the owner's quota.</p></> : <p>Loading workspace…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {canContribute && <WorkspaceUploader workspaceId={id} onDone={refresh} />}
    <section className="workspace-card">
      <h2>Current project files</h2>
      {isOwner && <><p className="muted">Add files already in My files. Workspace members can open and download them. Removing one here does not delete the file or an earlier snapshot.</p>
      <div className="workspace-inline"><select aria-label="File to add" value={addId}
        onChange={(event) => setAddId(event.target.value)}>
        <option value="">Choose a file</option>{available.map((file) =>
          <option key={file.id} value={file.id}>{file.name}</option>)}
      </select><button disabled={!addId || pending} onClick={() => void change(async () => {
        await api(routes.workspaceFiles(id), jsonOptions('POST', { fileId: addId })); setAddId('');
      })}>Add file</button></div></>}
      {!files.length && <p className="muted">No files in this workspace yet.</p>}
      <ul className="workspace-files">{files.map((file) => <li key={file.id}>
        <label>{isOwner && <input type="checkbox" checked={selected.includes(file.id)}
          disabled={reviewing || workspace?.git?.archiveFileId === file.id}
          onChange={(event) => setSelected((previous) => event.target.checked
            ? [...previous, file.id] : previous.filter((fileId) => fileId !== file.id))} />}
          {isOwner ? <Link to={`/view/${file.id}`}>{file.name}</Link> : <span>{file.name}</span>}
          <span className="muted">{formatBytes(file.size)}</span></label>
        <span className="workspace-inline"><a href={`${routes.workspaceContent(id, file.id)}?download=1`}>Download</a>
          {canContribute && <WorkspaceReplacement workspaceId={id} file={file} onDone={refresh} />}
          {isOwner && <button className="btn-ghost" disabled={pending || reviewing} onClick={() => void change(() =>
            api(routes.workspaceFile(id, file.id), { method: 'DELETE' }))}>Remove</button>}</span>
      </li>)}</ul>
    </section>
    {isOwner && <section className="workspace-card workspace-form">
      <h2>Link a Git code archive</h2>
      <p className="muted">From your code repository, run <code>git archive --format=zip --output=code.zip HEAD</code>, upload code.zip here, then link it. The ZIP comment supplies a commit label; DropVault does not verify that label against GitHub.</p>
      <div className="workspace-inline"><select aria-label="Git code archive" value={gitFileId}
        onChange={(event) => setGitFileId(event.target.value)}>
        <option value="">Choose a ZIP file</option>{files.filter((file) => file.name.toLowerCase().endsWith('.zip'))
          .map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
      </select><button disabled={!gitFileId || pending} onClick={() => void change(() =>
        api(routes.workspaceGit(id), jsonOptions('PUT', { fileId: gitFileId })))}>Link archive</button></div>
      {workspace.git && <p>Linked commit <code>{workspace.git.commitSha}</code> from a ZIP comment. The linked ZIP is included automatically in snapshots.</p>}
    </section>}
    {isOwner && <section className="workspace-card workspace-form">
      <h2>Save a snapshot</h2>
      <p className="muted">Choose completed files. A snapshot records their current version IDs and names. It uses no new bytes. Retained file versions count toward storage even after a snapshot is removed.</p>
      {linkedArchiveStale && <p className="error" role="alert">The linked code ZIP has a newer version. Link it again before saving a snapshot.</p>}
      {uploadsPending && <p className="error" role="alert">Finish pending uploads before creating a snapshot. Refresh this file list after they finish.</p>}
      {selected.length > 200 && <p className="error" role="alert">Choose at most 200 files for one snapshot.</p>}
      <label>Snapshot name<input value={name} maxLength={255} disabled={reviewing}
        onChange={(event) => setName(event.target.value)} /></label>
      <label>What does this snapshot represent?<textarea value={note} maxLength={1000}
        disabled={reviewing} onChange={(event) => setNote(event.target.value)} /></label>
      {reviewing ? <div className="workspace-review">
        {workspace.git && <p>Code archive commit: <code>{workspace.git.commitSha}</code>. Its ZIP is included below.</p>}
        <strong>Review “{name}” before saving</strong>
        <p>{reviewedItems.length} files · {formatBytes(reviewedItems.reduce((sum, file) => sum + file.size, 0))} already counted in storage</p>
        <ul>{reviewedItems.map((file) => <li key={file.id}>{file.name} · {formatBytes(file.size)} · current version {file.currentVersionId}</li>)}</ul>
        <div className="workspace-inline"><button disabled={pending} onClick={() => void createSnapshot()}>Create fixed snapshot</button>
          <button className="btn-ghost" disabled={pending} onClick={() => setReviewedItems(null)}>Change selection</button></div>
      </div> : <button disabled={pending || uploadsPending || linkedArchiveStale || !selected.length || selected.length > 200 || !name.trim()}
        onClick={() => { setError(''); setReviewedItems(chosen.map((file) => ({ ...file }))); }}>Review snapshot</button>}
    </section>}
    <section><h2>Saved snapshots</h2>{snapshots.length ? <div className="list">{snapshots.map((snapshot) =>
      <div className="row" key={snapshot.id}><Link className="row-main" to={`/snapshots/${snapshot.id}`}>
        <strong>{snapshot.name}</strong><span className="muted">{snapshot.items.length} files · {new Date(snapshot.createdAt).toLocaleString()}</span>
      </Link></div>)}</div> : <p className="muted">No snapshots yet.</p>}</section>
    {isOwner && <section className="workspace-card workspace-form"><h2>Team access</h2>
      <p className="muted">Viewers can browse and download. Contributors can also upload files and replace current versions. You choose which files enter a fixed snapshot.</p>
      <form className="workspace-inline" onSubmit={(event) => { event.preventDefault(); void change(async () => {
        await api(routes.workspaceAccess(id), jsonOptions('POST', { email: memberEmail, role: memberRole }));
        setMemberEmail('');
      }); }}>
        <input type="email" aria-label="Team member email" placeholder="Account email" required
          value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} />
        <select aria-label="Team member role" value={memberRole} onChange={(event) => setMemberRole(event.target.value)}>
          <option value="viewer">Viewer</option><option value="contributor">Contributor</option>
        </select><button disabled={pending}>Invite or update</button>
      </form>
      {members.length > 0 && <ul>{members.map((member) => <li key={member.userId}>
        {member.email} · {member.role} <button className="btn-ghost" disabled={pending}
          onClick={() => void change(() => api(routes.workspaceRecipient(id, member.userId),
            { method: 'DELETE' }))}>Remove</button>
      </li>)}</ul>}
    </section>}
    {isOwner && <section className="workspace-card"><h2>Delete workspace</h2>
      <p className="muted">Remove its snapshots first. Your files remain in My files.</p>
      {confirmDelete ? <div className="workspace-inline"><button className="btn-danger" disabled={pending}
        onClick={() => void change(async () => { await api(routes.workspace(id), { method: 'DELETE' }); navigate('/workspaces'); })}>Delete workspace</button>
        <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button></div>
        : <button className="btn-ghost" onClick={() => setConfirmDelete(true)}>Delete workspace…</button>}
    </section>}
  </section>;
}

export function SnapshotPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState(null);
  const [grants, setGrants] = useState([]);
  const [email, setEmail] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    api(routes.snapshot(id)).then(async (result) => {
      if (!active) return;
      setSnapshot(result);
      if (result.ownerId === user.id) {
        const access = await api(routes.snapshotAccess(id));
        if (active) setGrants(access.users);
      }
    }).catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [id, user.id]);
  const owned = snapshot?.ownerId === user.id;
  async function change(action) {
    setPending(true); setError('');
    try { await action(); }
    catch (caught) { setError(caught.message); }
    finally { setPending(false); }
  }
  return <section className="workspace-page">
    <Link to={owned ? `/workspaces/${snapshot.workspaceId}` : '/workspaces'}>← Workspaces</Link>
    {error && <p className="error" role="alert">{error}</p>}
    {snapshot ? <><h1>{snapshot.name}</h1>
      <p className="muted">Saved {new Date(snapshot.createdAt).toLocaleString()} · {snapshot.items.length} exact file versions</p>
      <p>{snapshot.note || 'No note.'}</p>
      {snapshot.git && <p>Code archive commit: <code>{snapshot.git.commitSha}</code> (ZIP comment supplied by uploader)</p>}
      <p className="muted">This snapshot is fixed. Later replacements, restores, renames, and folder moves do not change it.</p>
      <div className="workspace-inline">
        <a className="button-link" href={routes.snapshotArchive(id)}>Download all (.tar)</a>
        <button className="btn-ghost" disabled={pending} onClick={() => void change(async () => {
          const copy = await api(routes.snapshotCopy(id), { method: 'POST' });
          navigate(`/workspaces/${copy.id}`);
        })}>Restore as new workspace</button>
      </div>
      <p className="muted">Restoring copies every file into your account and requires enough free storage. Your current files stay as they are.</p>
      <div className="list">{snapshot.items.map((item) => <div className="row" key={item.fileId}>
        <div className="row-main"><strong>{item.name}</strong><span className="muted">{formatBytes(item.size)}</span></div>
        <div className="row-actions">{openableTypes.has(item.mimeType) && <a
          href={routes.snapshotContent(id, item.fileId)} target="_blank" rel="noopener noreferrer">Open</a>}
          <a className="button-link" href={`${routes.snapshotContent(id, item.fileId)}?download=1`}>Download</a></div>
      </div>)}</div>
      {owned && <><section className="workspace-card workspace-form"><h2>Share this snapshot</h2>
        <p className="muted">Workspace members can open this snapshot while they have workspace access. To share it with another account, grant that account access to every file first. Revoking a file grant removes separate snapshot access immediately.</p>
        <form onSubmit={(event) => { event.preventDefault(); void change(async () => {
          await api(routes.snapshotAccess(id), jsonOptions('POST', { email }));
          setGrants((await api(routes.snapshotAccess(id))).users); setEmail('');
        }); }} className="workspace-inline">
          <input type="email" value={email} placeholder="Recipient email" required
            onChange={(event) => setEmail(event.target.value)} />
          <button disabled={pending}>Share</button>
        </form>
        {grants.length ? <ul>{grants.map((grant) => <li key={grant.userId}>
          {grant.email} <button className="btn-ghost" disabled={pending} onClick={() => void change(async () => {
            await api(routes.snapshotRecipient(id, grant.userId), { method: 'DELETE' });
            setGrants((await api(routes.snapshotAccess(id))).users);
        })}>Remove access</button>
        </li>)}</ul> : <p className="muted">No separate snapshot invitations. Workspace members still have access.</p>}
        <p>{snapshot.items.map((item) => <span key={item.fileId}><Link to={`/view/${item.fileId}`}>{item.name} access</Link>{' · '}</span>)}</p>
      </section><section className="workspace-card"><h2>Delete snapshot</h2>
        <p className="muted">This releases its file pins. The file versions remain in history until their files are deleted.</p>
        {confirmDelete ? <div className="workspace-inline"><button className="btn-danger" disabled={pending}
          onClick={() => void change(async () => { await api(routes.snapshot(id), { method: 'DELETE' });
            navigate(`/workspaces/${snapshot.workspaceId}`); })}>Delete snapshot</button>
          <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button></div>
          : <button className="btn-ghost" onClick={() => setConfirmDelete(true)}>Delete snapshot…</button>}
      </section></>}
    </> : !error && <p>Loading snapshot…</p>}
  </section>;
}
