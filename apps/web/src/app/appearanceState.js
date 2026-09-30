import { DEFAULT_THEME_SETTINGS, THEME_FONTS, THEME_SPACINGS,
  validThemeSettings } from '../../../../packages/shared/index.js';

export const HEX = /^#[0-9a-f]{6}$/i;
export const STYLE_PROPERTIES = Object.freeze([
  '--paper', '--card', '--ink', '--accent', '--accent-contrast', '--app-font',
]);
export const defaultAppearance = {
  sourceThemeId: null, name: 'Default', settings: DEFAULT_THEME_SETTINGS,
  selectedAt: null, updatedAt: null,
};

export function appearanceCacheKey(userId) {
  return `dropvault.appearance.${userId}`;
}

export function safeSettings(settings) {
  return HEX.test(settings?.colors?.background) && HEX.test(settings?.colors?.surface)
    && HEX.test(settings?.colors?.text) && HEX.test(settings?.colors?.accent)
    && THEME_FONTS.includes(settings?.font)
    && THEME_SPACINGS.includes(settings?.spacing);
}

export function sameSettings(left, right) {
  return left?.font === right?.font && left?.spacing === right?.spacing
    && left?.colors?.background === right?.colors?.background
    && left?.colors?.surface === right?.colors?.surface
    && left?.colors?.text === right?.colors?.text
    && left?.colors?.accent === right?.colors?.accent;
}

export function validAppearance(value) {
  return Boolean(value) && typeof value === 'object'
    && (value.sourceThemeId === null || typeof value.sourceThemeId === 'string')
    && typeof value.name === 'string'
    && validThemeSettings(value.settings);
}

export function parseCachedAppearance(raw) {
  try {
    const parsed = JSON.parse(raw);
    return validAppearance(parsed) && safeSettings(parsed.settings) ? parsed : null;
  } catch {
    return null;
  }
}

export function readCachedAppearance(userId, storage = globalThis.localStorage) {
  try {
    if (!userId || !storage) return null;
    return parseCachedAppearance(storage.getItem(appearanceCacheKey(userId)));
  } catch {
    return null;
  }
}

export function writeCachedAppearance(userId, appearance, storage = globalThis.localStorage) {
  try {
    if (!userId || !storage || !validAppearance(appearance) || !safeSettings(appearance.settings)) {
      return false;
    }
    storage.setItem(appearanceCacheKey(userId), JSON.stringify(appearance));
    return true;
  } catch {
    return false;
  }
}

export function clearCachedAppearance(userId, storage = globalThis.localStorage) {
  try {
    if (!userId || !storage) return false;
    storage.removeItem(appearanceCacheKey(userId));
    return true;
  } catch {
    return false;
  }
}

export function clearAllCachedAppearances(storage = globalThis.localStorage) {
  try {
    if (!storage) return false;
    const keys = [];
    if (typeof storage.length === 'number' && typeof storage.key === 'function') {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (typeof key === 'string' && key.startsWith('dropvault.appearance.')) keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export const VISIBLE_REFRESH_MS = 60_000;

export function shouldRefreshOnVisible(lastRefreshAt, now = Date.now()) {
  if (!lastRefreshAt) return true;
  return now - lastRefreshAt >= VISIBLE_REFRESH_MS;
}

export function previewAfterNavigation(pathname, preview) {
  return typeof pathname === 'string' && pathname.startsWith('/themes') ? preview : null;
}

export function deriveAppearance({ user, saved, cached, preview, error, pathname }) {
  const safeCached = cached && safeSettings(cached.settings) ? cached : null;
  const savedForThisUser = user && saved?.userId === user.id
    ? saved
    : (user && safeCached ? { userId: user.id, appearance: safeCached } : null);
  const appearance = savedForThisUser?.appearance ?? defaultAppearance;
  const previewing = user && preview?.userId === user.id
    ? previewAfterNavigation(pathname ?? '/themes', preview)
    : null;
  const visibleSettings = previewing?.settings ?? appearance.settings;
  const loading = Boolean(user) && !savedForThisUser && !error;
  const followStylesheet = !previewing && appearance.sourceThemeId === null
    && sameSettings(appearance.settings, DEFAULT_THEME_SETTINGS);
  return { appearance, savedForThisUser, previewing, visibleSettings, loading, followStylesheet };
}

function accentTextColor(hex) {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? '#111827' : '#ffffff';
}

export function clearThemeOnRoot(root) {
  for (const property of STYLE_PROPERTIES) root.style.removeProperty(property);
  delete root.dataset.themeSpacing;
}

export function applyThemeToRoot(root, { followStylesheet, settings }) {
  if (followStylesheet) {
    clearThemeOnRoot(root);
    return;
  }
  const applied = safeSettings(settings) ? settings : DEFAULT_THEME_SETTINGS;
  const { colors, font, spacing } = applied;
  root.style.setProperty('--paper', colors.background);
  root.style.setProperty('--card', colors.surface);
  root.style.setProperty('--ink', colors.text);
  root.style.setProperty('--accent', colors.accent);
  root.style.setProperty('--accent-contrast', accentTextColor(colors.accent));
  root.style.setProperty('--app-font', `${font}, "Segoe UI", system-ui, sans-serif`);
  root.dataset.themeSpacing = spacing;
}
