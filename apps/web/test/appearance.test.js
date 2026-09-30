import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_THEME_SETTINGS, uniqueDisplayName } from '../../../packages/shared/index.js';
import { appearanceCacheKey, applyThemeToRoot, clearAllCachedAppearances, clearCachedAppearance,
  defaultAppearance, deriveAppearance, parseCachedAppearance, previewAfterNavigation,
  readCachedAppearance, safeSettings, shouldRefreshOnVisible, VISIBLE_REFRESH_MS,
  writeCachedAppearance } from '../src/app/appearanceState.js';

const customSettings = {
  colors: { background: '#111827', surface: '#1f2937', text: '#f5f7fa', accent: '#80b5ff' },
  font: 'Georgia',
  spacing: 'compact',
};
const customAppearance = {
  sourceThemeId: 'theme-1', name: 'Ocean', settings: customSettings,
  selectedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const preview = { userId: 'alex', id: 'theme-1', name: 'Ocean', settings: customSettings };

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) { return Object.hasOwn(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; },
    get length() { return Object.keys(data).length; },
    key(index) { return Object.keys(data)[index] ?? null; },
    data,
  };
}

function fakeRoot() {
  const props = {};
  const dataset = {};
  return {
    props,
    dataset,
    style: {
      setProperty(name, value) { props[name] = value; },
      removeProperty(name) { delete props[name]; },
    },
  };
}

test('logged-out render uses the default look and is not loading', () => {
  const view = deriveAppearance({
    user: null,
    saved: { userId: 'alex', appearance: customAppearance },
    cached: customAppearance,
    preview,
    error: '',
    pathname: '/login',
  });
  assert.equal(view.appearance, defaultAppearance);
  assert.equal(view.loading, false);
  assert.equal(view.previewing, null);
  assert.equal(view.followStylesheet, true);
});

test('cached appearance is the initial saved value for that user', () => {
  const view = deriveAppearance({
    user: { id: 'alex' }, saved: null, cached: customAppearance, preview: null, error: '',
    pathname: '/files',
  });
  assert.equal(view.appearance.name, 'Ocean');
  assert.equal(view.loading, false);
  assert.equal(view.followStylesheet, false);
});

test('signed-in with no cache or saved appearance is loading', () => {
  const view = deriveAppearance({
    user: { id: 'alex' }, saved: null, cached: null, preview: null, error: '',
    pathname: '/files',
  });
  assert.equal(view.appearance, defaultAppearance);
  assert.equal(view.loading, true);
});

test('a load error is not treated as the default still loading', () => {
  const view = deriveAppearance({
    user: { id: 'alex' }, saved: null, cached: null, preview: null, error: 'offline',
    pathname: '/files',
  });
  assert.equal(view.loading, false);
  assert.equal(view.appearance, defaultAppearance);
});

test('switching users mid-preview drops the previous account preview', () => {
  const view = deriveAppearance({
    user: { id: 'blair' },
    saved: { userId: 'alex', appearance: customAppearance },
    cached: null,
    preview,
    error: '',
    pathname: '/themes',
  });
  assert.equal(view.previewing, null);
  assert.equal(view.appearance, defaultAppearance);
  assert.equal(view.loading, true);
});

test('preview clears when leaving /themes', () => {
  assert.equal(previewAfterNavigation('/themes', preview), preview);
  assert.equal(previewAfterNavigation('/themes/theme-1', preview), preview);
  assert.equal(previewAfterNavigation('/files', preview), null);
  const onFiles = deriveAppearance({
    user: { id: 'alex' }, saved: { userId: 'alex', appearance: customAppearance },
    cached: null, preview, error: '', pathname: '/files',
  });
  assert.equal(onFiles.previewing, null);
  assert.equal(onFiles.visibleSettings, customSettings);
});

test('unsafe settings are rejected before they reach CSS variables', () => {
  assert.equal(safeSettings(customSettings), true);
  assert.equal(safeSettings({ ...customSettings, spacing: 'huge' }), false);
  assert.equal(safeSettings({
    ...customSettings, colors: { ...customSettings.colors, background: 'red; } body { display:none' },
  }), false);
  assert.equal(safeSettings({ ...customSettings, font: 'Comic Sans' }), false);
  const root = fakeRoot();
  applyThemeToRoot(root, {
    followStylesheet: false,
    settings: { ...customSettings, font: 'Comic Sans' },
  });
  assert.equal(root.props['--paper'], DEFAULT_THEME_SETTINGS.colors.background);
  assert.equal(root.dataset.themeSpacing, DEFAULT_THEME_SETTINGS.spacing);
});

test('unmodified default appearance leaves the stylesheet in charge', () => {
  const root = fakeRoot();
  root.style.setProperty('--paper', '#111827');
  root.dataset.themeSpacing = 'compact';
  applyThemeToRoot(root, { followStylesheet: true, settings: DEFAULT_THEME_SETTINGS });
  assert.equal(root.props['--paper'], undefined);
  assert.equal(root.dataset.themeSpacing, undefined);
});

test('custom compact spacing is written to the root dataset', () => {
  const root = fakeRoot();
  applyThemeToRoot(root, { followStylesheet: false, settings: customSettings });
  assert.equal(root.dataset.themeSpacing, 'compact');
  assert.equal(root.props['--ink'], customSettings.colors.text);
});

test('appearance cache ignores blocked storage and invalid JSON', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(readCachedAppearance('alex', blocked), null);
  assert.equal(writeCachedAppearance('alex', customAppearance, blocked), false);
  assert.equal(parseCachedAppearance('{'), null);
  assert.equal(parseCachedAppearance(JSON.stringify({ name: 'nope' })), null);
  const storage = memoryStorage();
  assert.equal(writeCachedAppearance('alex', customAppearance, storage), true);
  assert.equal(readCachedAppearance('alex', storage).name, 'Ocean');
  assert.equal(storage.data[appearanceCacheKey('alex')].includes('Ocean'), true);
});

test('cached appearance is keyed by user and must pass safe() before CSS', () => {
  const storage = memoryStorage();
  writeCachedAppearance('alex', customAppearance, storage);
  writeCachedAppearance('blair', { ...customAppearance, name: 'Forest' }, storage);
  assert.equal(readCachedAppearance('alex', storage).name, 'Ocean');
  assert.equal(readCachedAppearance('blair', storage).name, 'Forest');
  const injected = {
    ...customAppearance,
    settings: { ...customSettings, colors: { ...customSettings.colors, background: 'red; } body{display:none' } },
  };
  assert.equal(writeCachedAppearance('alex', injected, storage), false);
  assert.equal(parseCachedAppearance(JSON.stringify(injected)), null);
  const view = deriveAppearance({
    user: { id: 'alex' }, saved: null, cached: injected, preview: null, error: '', pathname: '/files',
  });
  assert.equal(view.appearance, defaultAppearance);
  const root = fakeRoot();
  applyThemeToRoot(root, { followStylesheet: false, settings: injected.settings });
  assert.equal(root.props['--paper'], DEFAULT_THEME_SETTINGS.colors.background);
  clearCachedAppearance('alex', storage);
  assert.equal(readCachedAppearance('alex', storage), null);
  assert.equal(readCachedAppearance('blair', storage).name, 'Forest');
});

test('visibility refetch waits a minute between tab switches', () => {
  assert.equal(shouldRefreshOnVisible(0, 1), true);
  const justNow = 1_000_000;
  assert.equal(shouldRefreshOnVisible(justNow, justNow + 1_000), false);
  assert.equal(shouldRefreshOnVisible(justNow, justNow + VISIBLE_REFRESH_MS), true);
});

test('display names stay unique with a short suffix', () => {
  assert.equal(uniqueDisplayName('Alex', []), 'Alex');
  assert.equal(uniqueDisplayName('Alex', ['Alex']), 'Alex-2');
  assert.equal(uniqueDisplayName('alex', ['Alex']), 'alex-2');
});

test('a 401 can clear every cached appearance on the machine', () => {
  const storage = memoryStorage();
  writeCachedAppearance('alex', customAppearance, storage);
  writeCachedAppearance('blair', { ...customAppearance, name: 'Forest' }, storage);
  clearAllCachedAppearances(storage);
  assert.equal(readCachedAppearance('alex', storage), null);
  assert.equal(readCachedAppearance('blair', storage), null);
});
