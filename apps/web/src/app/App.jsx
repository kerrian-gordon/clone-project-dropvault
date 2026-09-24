import { useState } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { FilesPage } from '../features/file-browser/FilesPage.jsx';
import { SharedPage } from '../features/file-browser/SharedPage.jsx';
import { ViewerPage } from '../features/viewer/ViewerPage.jsx';

function ProtectedLayout() {
  const { user, loading, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

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
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/files">Dropvault</Link>
        <nav aria-label="Main navigation">
          <NavLink to="/files">My files</NavLink>
          <NavLink to="/shared">Shared with me</NavLink>
        </nav>
        <div className="account"><span>{user.email}</span><button type="button" onClick={handleLogout}>Log out</button></div>
      </header>
      <main className="content"><Outlet /></main>
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
      await signIn(mode, data.get('email'), data.get('password'));
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
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route element={<ProtectedLayout />}>
          <Route path="/" element={<Navigate to="/files" replace />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/folders/:id" element={<FilesPage />} />
          <Route path="/shared" element={<SharedPage />} />
          <Route path="/view/:id" element={<ViewerPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
