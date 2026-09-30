import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DEFAULT_THEME_SETTINGS, THEME_FONTS, THEME_SPACINGS, routes,
  themeContrastIssues } from '../../../../../packages/shared/index.js';
import { useAuth } from '../../app/AuthContext.jsx';
import { useAppearance } from '../../app/AppearanceContext.jsx';
import { api } from '../../shared/lib/api.js';
import { ThemePreviewBanner, ThemeSample, colorLabels } from './ThemePreview.jsx';

function galleryPath(offset, search) {
  const params = new URLSearchParams({ offset: String(offset), limit: '20' });
  const trimmed = search.trim();
  if (trimmed) params.set('q', trimmed);
  return `${routes.themes}?${params}`;
}

export function ThemesPage() {
  const { user } = useAuth();
  const { appearance, loading, error: appearanceError, saving, install, saveSettings, reset,
    previewing, startPreview, stopPreview } = useAppearance();
  const [themes, setThemes] = useState([]);
  const [nextOffset, setNextOffset] = useState(null);
  const [galleryError, setGalleryError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_THEME_SETTINGS);
  const [name, setName] = useState('');
  const [creatorName, setCreatorName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const draftIssues = themeContrastIssues(draft);
  const savedIssues = themeContrastIssues(appearance.settings);

  useEffect(() => { setDraft(structuredClone(appearance.settings)); }, [appearance]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let active = true;
    setGalleryError('');
    api(galleryPath(0, debouncedSearch))
      .then((page) => {
        if (active) { setThemes(page.themes); setNextOffset(page.nextOffset); }
      })
      .catch((caught) => { if (active) setGalleryError(caught.message); });
    return () => { active = false; };
  }, [debouncedSearch]);

  async function run(action, success) {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
    } catch (caught) {
      setActionError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    setGalleryError('');
    try {
      const page = await api(galleryPath(nextOffset, debouncedSearch));
      setThemes((current) => [...current, ...page.themes]);
      setNextOffset(page.nextOffset);
    } catch (caught) {
      setGalleryError(caught.message);
    } finally {
      setLoadingMore(false);
    }
  }

  function changeColor(key, value) {
    setDraft((current) => ({ ...current, colors: { ...current.colors, [key]: value } }));
  }

  async function publish(event) {
    event.preventDefault();
    await run(async () => {
      const theme = await api(routes.themes, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, creatorName, settings: appearance.settings }),
      });
      setThemes((current) => [theme, ...current]);
      setNextOffset((current) => current === null ? null : current + 1);
      setName('');
      setCreatorName('');
    }, 'Your current appearance is published in the gallery.');
  }

  async function removeTheme(theme) {
    await run(async () => {
      await api(routes.theme(theme.id), { method: 'DELETE' });
      setThemes((current) => current.filter((item) => item.id !== theme.id));
      setNextOffset((current) => current === null ? null : Math.max(0, current - 1));
      setConfirmDeleteId(null);
      if (previewing?.id === theme.id) stopPreview();
    }, 'Theme removed from the gallery. Installed personal copies are kept.');
  }

  return <section className="themes-page">
    <h1>Themes</h1>
    <p className="muted">Install a community theme, adjust your own copy, and keep it for your next visit.</p>
    {appearanceError && <p className="error" role="alert">Could not load your saved appearance: {appearanceError}</p>}
    {actionError && <p className="error" role="alert">{actionError}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {previewing && <ThemePreviewBanner previewing={previewing} busy={busy || saving}
      onInstall={() => run(() => install(previewing.id), `${previewing.name} is now your appearance.`)}
      onCancel={stopPreview} />}

    <section className="theme-section" aria-labelledby="current-theme-title">
      <h2 id="current-theme-title">Your appearance</h2>
      <p>{loading ? 'Loading your appearance…' : <>Using <strong>{appearance.name}</strong>{appearance.sourceThemeId ? ' (personal copy)' : ''}</>}</p>
      <ThemeSample settings={appearance.settings} />
      <div className="theme-actions"><button className="btn-ghost" type="button" disabled={busy || loading || saving} onClick={() => run(reset, 'Default appearance restored.')}>Use default</button></div>
    </section>

    <section className="theme-section" aria-labelledby="customize-title">
      <h2 id="customize-title">Customize your copy</h2>
      <p className="muted">Changes here affect only your account. Text and accent colors need enough contrast with the background and cards.</p>
      <div className="theme-controls">
        {Object.entries(colorLabels).map(([key, label]) => <label key={key}>{label}
          <input type="color" value={draft.colors[key]} onChange={(event) => changeColor(key, event.target.value)} />
        </label>)}
        <label>Font<select value={draft.font} onChange={(event) => setDraft((current) => ({ ...current, font: event.target.value }))}>
          {THEME_FONTS.map((font) => <option key={font} value={font}>{font}</option>)}
        </select></label>
        <label>Spacing<select value={draft.spacing} onChange={(event) => setDraft((current) => ({ ...current, spacing: event.target.value }))}>
          {THEME_SPACINGS.map((spacing) => <option key={spacing} value={spacing}>{spacing}</option>)}
        </select></label>
      </div>
      <ThemeSample settings={draft} />
      {draftIssues.length > 0 && <p className="error" role="alert">{draftIssues.join('; ')}. Adjust the colors before saving.</p>}
      <div className="theme-actions"><button type="button" disabled={busy || loading || saving || draftIssues.length > 0} onClick={() => run(() => saveSettings(draft), 'Your appearance has been saved.')}>Save my changes</button></div>
    </section>

    <section className="theme-section" aria-labelledby="publish-title">
      <h2 id="publish-title">Share your design</h2>
      <p className="muted">Publishing makes a snapshot of your saved appearance available to other signed-in users.</p>
      <form className="theme-publish" onSubmit={publish}>
        <label>Public creator name<input value={creatorName} onChange={(event) => setCreatorName(event.target.value)} maxLength={50} required /></label>
        <label>Theme name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></label>
        <button type="submit" disabled={busy || loading || saving || savedIssues.length > 0}>Publish theme</button>
      </form>
      {savedIssues.length > 0 && <p className="error">Update your saved colors before publishing: {savedIssues.join('; ')}.</p>}
    </section>

    <section className="theme-section" aria-labelledby="gallery-title">
      <h2 id="gallery-title">Community gallery</h2>
      <form className="theme-search" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="theme-search">Search by name or creator</label>
        <input id="theme-search" type="search" value={search} maxLength={80}
          placeholder="Ocean, Alex…"
          onChange={(event) => setSearch(event.target.value)} />
      </form>
      {galleryError && <p className="error" role="alert">{galleryError}</p>}
      {themes.length === 0 && !galleryError && <p className="muted">{debouncedSearch.trim()
        ? 'No themes match that search.'
        : 'No themes published yet. Share yours to start the gallery.'}</p>}
      <div className="theme-grid">{themes.map((theme) => <article className="theme-card" key={theme.id}>
        <ThemeSample settings={theme.settings} />
        <h3>{theme.name}</h3>
        <p className="muted">By {theme.creatorName || 'Community member'} · {new Date(theme.createdAt).toLocaleDateString()}</p>
        <p><Link to={`/themes/${encodeURIComponent(theme.id)}`}>View details</Link></p>
        <div className="theme-card-actions"><button type="button" className="btn-ghost" disabled={busy || loading || saving} onClick={() => startPreview(theme)}>Preview</button>
        <button type="button" disabled={busy || loading || saving} onClick={() => run(() => install(theme.id), `${theme.name} is now your appearance.`)}>
          {appearance.sourceThemeId === theme.id ? 'Install again' : 'Install theme'}
        </button></div>
        {theme.creatorId === user.id && (confirmDeleteId === theme.id
          ? <div className="theme-remove-confirm"><span>Remove from gallery?</span>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => removeTheme(theme)}>Remove</button>
            <button type="button" className="btn-ghost" onClick={() => setConfirmDeleteId(null)}>Cancel</button></div>
          : <button type="button" className="btn-ghost theme-remove" disabled={busy} onClick={() => setConfirmDeleteId(theme.id)}>Remove my theme</button>)}
      </article>)}</div>
      {nextOffset !== null && <button type="button" className="btn-ghost" disabled={loadingMore} onClick={loadMore}>Load more themes</button>}
    </section>
  </section>;
}
