import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
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
  const [saved, setSaved] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
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
    const accountId = user.id;
    const value = await api(path, options);
    setSaved({ userId: accountId, appearance: value });
    writeCachedAppearance(accountId, value);
    setPreview(null);
    setError('');
    return value;
  }

  const jsonPut = (body) => ({
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  return <AppearanceContext.Provider value={{
    appearance, loading, error, previewing,
    startPreview: (theme) => setPreview({ userId: user.id, id: theme.id,
      name: theme.name, settings: theme.settings }),
    stopPreview: () => setPreview(null),
    install: (themeId) => update(routes.appearance, jsonPut({ themeId })),
    saveSettings: (settings) => update(routes.appearanceSettings, jsonPut({ settings })),
    reset: () => update(routes.appearance, { method: 'DELETE' }),
  }}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  return useContext(AppearanceContext);
}
