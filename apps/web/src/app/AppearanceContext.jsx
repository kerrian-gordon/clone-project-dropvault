import { createContext, useContext, useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { DEFAULT_THEME_SETTINGS, routes } from '../../../../packages/shared/index.js';
import { api } from '../shared/lib/api.js';
import { useAuth } from './AuthContext.jsx';

const AppearanceContext = createContext(null);
const defaultAppearance = {
  sourceThemeId: null, name: 'Default', settings: DEFAULT_THEME_SETTINGS,
  selectedAt: null, updatedAt: null,
};

function accentTextColor(hex) {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? '#111827' : '#ffffff';
}

export function AppearanceProvider({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  const [saved, setSaved] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const appearance = saved?.userId === user?.id ? saved.appearance : defaultAppearance;
  const visibleSettings = preview?.userId === user?.id ? preview.settings : appearance.settings;

  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    api(routes.appearance)
      .then((value) => { if (active) setSaved({ userId: user.id, appearance: value }); })
      .catch((caught) => { if (active) setError(caught.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user?.id]);

  useEffect(() => {
    setLoading(Boolean(user));
    setError('');
    setPreview(null);
  }, [user?.id]);

  useEffect(() => { setPreview(null); }, [location.pathname]);

  useEffect(() => {
    const root = document.documentElement;
    const { colors, font, spacing } = visibleSettings;
    root.style.setProperty('--paper', colors.background);
    root.style.setProperty('--card', colors.surface);
    root.style.setProperty('--ink', colors.text);
    root.style.setProperty('--accent', colors.accent);
    root.style.setProperty('--accent-contrast', accentTextColor(colors.accent));
    root.style.setProperty('--app-font', `${font}, "Segoe UI", system-ui, sans-serif`);
    root.dataset.themeSpacing = spacing;
    return () => {
      for (const property of ['--paper', '--card', '--ink', '--accent', '--accent-contrast', '--app-font']) {
        root.style.removeProperty(property);
      }
      delete root.dataset.themeSpacing;
    };
  }, [visibleSettings]);

  async function update(path, options) {
    const accountId = user.id;
    const value = await api(path, options);
    setSaved({ userId: accountId, appearance: value });
    setPreview(null);
    setError('');
    return value;
  }

  const jsonPut = (body) => ({
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  return <AppearanceContext.Provider value={{
    appearance, loading, error, previewing: preview?.userId === user?.id ? preview : null,
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
