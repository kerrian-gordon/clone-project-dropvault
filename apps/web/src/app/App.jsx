import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router';
import { ROOT_FOLDER_ID, SUPPORTED_UPLOAD_TYPES } from '../../../../packages/shared/index.js';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { AppearanceProvider } from './AppearanceContext.jsx';
import { FilesPage } from '../features/file-browser/FilesPage.jsx';
import { SharedPage } from '../features/file-browser/SharedPage.jsx';
import { ViewerPage } from '../features/viewer/ViewerPage.jsx';
import { UploadProvider, useUploads } from '../features/upload/UploadContext.jsx';
import { ThemesPage } from '../features/themes/ThemesPage.jsx';
import { ThemeDetailPage } from '../features/themes/ThemeDetailPage.jsx';
import { WorkspacesPage, WorkspacePage, SnapshotPage } from '../features/workspaces/WorkspacesPage.jsx';
import { StorageMeter } from '../shared/components/StorageMeter.jsx';
import { StorageProvider, useStorage } from '../shared/lib/useStorage.jsx';
import { filesNavCurrent, workspacesNavCurrent } from './navCurrent.js';

function ProtectedLayout() {
  const { user, loading, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const filesActive = filesNavCurrent(location.pathname);
  const workspacesActive = workspacesNavCurrent(location.pathname);

  if (loading) return <main className="centered">Checking your session…</main>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;

  async function handleLogout() {
    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch (error) {
      window.alert(error.message);
    }
  }

  return (
    <UploadProvider>
      <StorageProvider>
        <SignedInShell user={user} filesActive={filesActive} workspacesActive={workspacesActive}
          onLogout={handleLogout} />
      </StorageProvider>
    </UploadProvider>
  );
}

function searchTarget(pathname) {
  if (pathname === '/themes' || pathname.startsWith('/themes/')) return '/themes';
  if (pathname === '/files' || pathname.startsWith('/folders/')) return pathname;
  return '/files';
}

function ShellSearch() {
  const location = useLocation();
  const navigate = useNavigate();
  const [value, setValue] = useState(() => new URLSearchParams(location.search).get('q') || '');
  const onThemes = location.pathname === '/themes' || location.pathname.startsWith('/themes/');

  useEffect(() => {
    setValue(new URLSearchParams(location.search).get('q') || '');
  }, [location.pathname, location.search]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = value.trim();
      const current = new URLSearchParams(location.search).get('q') || '';
      if (trimmed === current) return;
      const path = searchTarget(location.pathname);
      navigate(trimmed ? `${path}?q=${encodeURIComponent(trimmed)}` : path, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [value, location.pathname, location.search, navigate]);

  return <form role="search" className="shell-search" onSubmit={(event) => event.preventDefault()}>
    <label className="visually-hidden" htmlFor="shell-search">
      {onThemes ? 'Search themes by name or creator' : 'Search files and folders'}
    </label>
    <input id="shell-search" type="search" maxLength={80} value={value}
      placeholder={onThemes ? 'Ocean, Alex…' : 'Search files and folders'}
      onChange={(event) => setValue(event.target.value)} />
  </form>;
}

function SignedInShell({ user, filesActive, workspacesActive, onLogout }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { enqueue } = useUploads();
  const { usage, error } = useStorage();
  const input = useRef(null);
  const folderMatch = useMatch('/folders/:id');
  const folderId = folderMatch?.params.id || ROOT_FOLDER_ID;
  const accept = Object.keys(SUPPORTED_UPLOAD_TYPES).map((extension) => `.${extension}`).join(',');

  function pickFiles(event) {
    const files = event.target.files;
    event.target.value = '';
    if (!files?.length) return;
    enqueue(files, folderId);
    if (!filesNavCurrent(location.pathname) || location.pathname.startsWith('/view/')) {
      navigate(folderMatch ? `/folders/${folderMatch.params.id}` : '/files');
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="brand" to="/files">Dropvault</Link>
        <button type="button" className="create" onClick={() => input.current?.click()}>Upload</button>
        <input ref={input} className="visually-hidden" type="file" multiple accept={accept}
          aria-label="Upload files" onChange={pickFiles} />
        <nav aria-label="Main navigation">
          <Link
            to="/files"
            className={filesActive ? 'active' : undefined}
            aria-current={filesActive ? 'page' : undefined}
          >My files</Link>
          <NavLink to="/shared">Shared with me</NavLink>
          <NavLink to="/themes">Themes</NavLink>
          <Link
            to="/workspaces"
            className={workspacesActive ? 'active' : undefined}
            aria-current={workspacesActive ? 'page' : undefined}
          >Workspaces</Link>
        </nav>
        <StorageMeter usage={usage} error={error} />
      </aside>
      <div className="shell-main">
        <header className="shell-top">
          <ShellSearch />
          <div className="account">
            <span>{user.email}</span>
            <button type="button" onClick={onLogout}>Log out</button>
          </div>
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}

function AuthPage({ mode }) {
  const { user, loading, signIn } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const destination = location.state?.from?.startsWith('/') && !location.state.from.startsWith('//')
    ? location.state.from : '/files';

  if (loading) return <main className="centered">Checking your session…</main>;
  if (user) return <Navigate to={destination} replace />;

  async function submit(event) {
    event.preventDefault();
    setError('');
    setPending(true);
    const data = new FormData(event.currentTarget);
    try {
      await signIn(mode, data.get('email'), data.get('password'), data.get('displayName'));
      navigate(destination, { replace: true });
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  const registering = mode === 'register';
  return (
    <main className="auth-card">
      <Link className="brand" to="/files">Dropvault</Link>
      <h1>{registering ? 'Create an account' : 'Log in'}</h1>
      <form onSubmit={submit}>
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        {registering && <label>Display name<input name="displayName" maxLength={50} autoComplete="nickname" required />
          <span className="muted">Shown publicly on themes you publish.</span></label>}
        <label>Password<input name="password" type="password" minLength={registering ? 12 : undefined} autoComplete={registering ? 'new-password' : 'current-password'} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={pending}>{pending ? 'Please wait…' : registering ? 'Create account' : 'Log in'}</button>
      </form>
      <p className="muted">Dropvault runs on this computer. There is no public site.</p>
      <p>{registering ? 'Already have an account?' : 'New to Dropvault?'}{' '}
        <Link to={registering ? '/login' : '/register'} state={location.state}>{registering ? 'Log in' : 'Create one'}</Link>
      </p>
    </main>
  );
}

function NotFoundPage() {
  return <main className="centered">
    <h1>Page not found</h1>
    <p className="muted">Dropvault is a local app. A public website is not deployed.</p>
    <Link to="/files">Go to my files</Link>
  </main>;
}

export function App() {
  return (
    <AuthProvider>
      <AppearanceProvider><Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route element={<ProtectedLayout />}>
          <Route path="/" element={<Navigate to="/files" replace />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/folders/:id" element={<FilesPage />} />
          <Route path="/shared" element={<SharedPage />} />
          <Route path="/view/:id" element={<ViewerPage />} />
          <Route path="/themes" element={<ThemesPage />} />
          <Route path="/themes/:id" element={<ThemeDetailPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/workspaces/:id" element={<WorkspacePage />} />
          <Route path="/snapshots/:id" element={<SnapshotPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes></AppearanceProvider>
    </AuthProvider>
  );
}
