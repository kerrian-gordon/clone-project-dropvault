import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { routes } from '../../../../packages/shared/index.js';
import { api } from '../shared/lib/api.js';
import { useAuth } from './AuthContext.jsx';
import { appearanceCacheKey, applyThemeToRoot, clearCachedAppearance, deriveAppearance,
  parseCachedAppearance, readCachedAppearance, shouldRefreshOnVisible, writeCachedAppearance } from './appearanceState.js';

const AppearanceContext = createContext(null);

export function AppearanceProvider({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  const userId = user?.id;
  const userIdRef = useRef(userId);
  const previousUserIdRef = useRef(userId);
  userIdRef.current = userId;
  const mutationRef = useRef(0);
  const lastRefreshAtRef = useRef(0);
  const [saved, setSaved] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const cached = useMemo(() => readCachedAppearance(userId), [userId]);
  const { appearance, previewing, visibleSettings, loading, followStylesheet } = deriveAppearance({
    user, saved, cached, preview, error, pathname: location.pathname,
  });

  const refresh = useCallback(async () => {
    const accountId = userIdRef.current;
    if (!accountId) return;
    setError('');
    try {
      const value = await api(routes.appearance);
      if (userIdRef.current !== accountId) return;
      setSaved({ userId: accountId, appearance: value });
      writeCachedAppearance(accountId, value);
      lastRefreshAtRef.current = Date.now();
    } catch (caught) {
      if (userIdRef.current === accountId) setError(caught.message);
    }
  }, []);

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
        lastRefreshAtRef.current = Date.now();
      })
      .catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    setPreview((current) => current && location.pathname.startsWith('/themes') ? current : null);
  }, [location.pathname]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    applyThemeToRoot(root, { followStylesheet, settings: visibleSettings });
    return () => applyThemeToRoot(root, { followStylesheet: true, settings: visibleSettings });
  }, [followStylesheet, visibleSettings]);

  useEffect(() => {
    const previous = previousUserIdRef.current;
    if (!userId && previous) clearCachedAppearance(previous);
    previousUserIdRef.current = userId;
  }, [userId]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      if (!shouldRefreshOnVisible(lastRefreshAtRef.current)) return;
      lastRefreshAtRef.current = Date.now();
      void refresh();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  useEffect(() => {
    if (!userId) return undefined;
    function onStorage(event) {
      if (event.key !== appearanceCacheKey(userId) || !event.newValue) return;
      const next = parseCachedAppearance(event.newValue);
      if (next) setSaved({ userId, appearance: next });
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);

  const update = useCallback(async (path, options) => {
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
  }, []);

  const jsonPut = useCallback((body) => ({
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), []);

  const startPreview = useCallback((theme) => {
    const accountId = userIdRef.current;
    if (!accountId) return;
    setPreview({ userId: accountId, id: theme.id, name: theme.name, settings: theme.settings });
  }, []);
  const stopPreview = useCallback(() => setPreview(null), []);
  const install = useCallback((themeId) => update(routes.appearance, jsonPut({ themeId })), [jsonPut, update]);
  const saveSettings = useCallback((settings) => update(routes.appearanceSettings, jsonPut({ settings })),
    [jsonPut, update]);
  const reset = useCallback(() => update(routes.appearance, { method: 'DELETE' }), [update]);

  const value = useMemo(() => ({
    appearance, loading, error, saving, previewing, startPreview, stopPreview,
    install, saveSettings, reset, refresh,
  }), [appearance, loading, error, saving, previewing, startPreview, stopPreview,
    install, saveSettings, reset, refresh]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  return useContext(AppearanceContext);
}
