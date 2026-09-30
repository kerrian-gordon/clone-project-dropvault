import { useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { AppearanceProvider } from './AppearanceContext.jsx';
import { FilesPage } from '../features/file-browser/FilesPage.jsx';
import { SharedPage } from '../features/file-browser/SharedPage.jsx';
import { ViewerPage } from '../features/viewer/ViewerPage.jsx';
import { UploadProvider } from '../features/upload/UploadContext.jsx';
import { ThemesPage } from '../features/themes/ThemesPage.jsx';
import { ThemeDetailPage } from '../features/themes/ThemeDetailPage.jsx';

function ProtectedLayout() {
  const { user, loading, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const inFolder = Boolean(useMatch('/folders/*'));
  const filesActive = Boolean(useMatch('/files')) || inFolder;

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
      <div className="shell">
        <aside className="sidebar">
          <Link className="brand" to="/files">Dropvault</Link>
          {/* No Upload control yet. UploadProvider has no "open picker" action, and a link to
              /files is a no-op on Files and leaves the folder on /folders/:id. Later: a <button>
              that opens a hidden file input and calls enqueue for the current folder, and then
              demote the drop zone's Choose files to secondary (one blue button per area). */}
          <nav aria-label="Main navigation">
            <Link
              to="/files"
              className={filesActive ? 'active' : undefined}
              aria-current={filesActive ? 'page' : undefined}
            >My files</Link>
            <NavLink to="/shared">Shared with me</NavLink>
            <NavLink to="/themes">Themes</NavLink>
          </nav>
          {/* Storage meter: leave it out until there is ONE usage context. Files also calls
              useStorage() for the 507 upgrade retry, so a second copy here would go stale after
              an upgrade. Then render <StorageMeter /> here; .sidebar .storage-meter pins it. */}
        </aside>
        <div className="shell-main">
          <header className="shell-top">
            {/* Add <form role="search" className="shell-search"> only when search works;
                a dead input is worse than none in a demo. */}
            <div className="account">
              <span>{user.email}</span>
              <button type="button" onClick={handleLogout}>Log out</button>
            </div>
          </header>
          <main className="content"><Outlet /></main>
        </div>
      </div>
    </UploadProvider>
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
          <span className="muted">Public on themes you publish. Pick something you are willing to show.</span></label>}
        <label>Password<input name="password" type="password" minLength={registering ? 12 : undefined} autoComplete={registering ? 'new-password' : 'current-password'} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={pending}>{pending ? 'Please wait…' : registering ? 'Create account' : 'Log in'}</button>
      </form>
      <p>{registering ? 'Already have an account?' : 'New to Dropvault?'}{' '}
        <Link to={registering ? '/login' : '/register'} state={location.state}>{registering ? 'Log in' : 'Create one'}</Link>
      </p>
    </main>
  );
}

function NotFoundPage() {
  return <main className="centered"><h1>Page not found</h1><Link to="/files">Go to my files</Link></main>;
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
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes></AppearanceProvider>
    </AuthProvider>
  );
}
