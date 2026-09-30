import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { routes } from '../../../../packages/shared/index.js';
import { api } from '../shared/lib/api.js';
import { useAuth } from './AuthContext.jsx';
import { applyThemeToRoot, deriveAppearance, readCachedAppearance,
  writeCachedAppearance } from './appearanceState.js';

const AppearanceContext = createContext(null);

export function AppearanceProvider({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  const userId = user?.id;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const mutationRef = useRef(0);
  const [saved, setSaved] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const cached = useMemo(() => readCachedAppearance(userId), [userId]);
  const { appearance, previewing, visibleSettings, loading } = deriveAppearance({
    user, saved, cached, preview, error, pathname: location.pathname,
  });

  useEffect(() => {
    setPreview(null);
    setError('');
    if (!userId) return undefined;
    const accountId = userId;
    let active = true;
    api(routes.appearance)
      .then((value) => {
        if (!active) return;
        setSaved({ userId: accountId, appearance: value });
        writeCachedAppearance(accountId, value);
      })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    setPreview((current) => current && location.pathname.startsWith('/themes') ? current : null);
  }, [location.pathname]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    applyThemeToRoot(root, { followStylesheet: false, settings: visibleSettings });
    return () => applyThemeToRoot(root, { followStylesheet: true, settings: visibleSettings });
  }, [visibleSettings]);

  async function update(path, options) {
    const accountId = userIdRef.current;
    if (!accountId) throw new Error('Sign in to continue');
    const requestId = mutationRef.current += 1;
    setSaving(true);
    try {
      const value = await api(path, options);
      if (requestId !== mutationRef.current || userIdRef.current !== accountId) return value;
      setSaved({ userId: accountId, appearance: value });
      writeCachedAppearance(accountId, value);
      setPreview(null);
      setError('');
      return value;
    } catch (caught) {
      if (requestId === mutationRef.current && userIdRef.current === accountId) {
        setError(caught.message);
      }
      throw caught;
    } finally {
      if (requestId === mutationRef.current) setSaving(false);
    }
  }

  const jsonPut = (body) => ({
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  return <AppearanceContext.Provider value={{
    appearance, loading, error, saving, previewing,
    startPreview: (theme) => {
      const accountId = userIdRef.current;
      if (!accountId) return;
      setPreview({ userId: accountId, id: theme.id, name: theme.name, settings: theme.settings });
    },
    stopPreview: () => setPreview(null),
    install: (themeId) => update(routes.appearance, jsonPut({ themeId })),
    saveSettings: (settings) => update(routes.appearanceSettings, jsonPut({ settings })),
    reset: () => update(routes.appearance, { method: 'DELETE' }),
  }}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  return useContext(AppearanceContext);
}
