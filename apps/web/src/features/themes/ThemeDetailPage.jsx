import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '../../../../../packages/shared/index.js';
import { useAppearance } from '../../app/AppearanceContext.jsx';
import { api } from '../../shared/lib/api.js';
import { ThemePreviewBanner, ThemeSample, colorLabels } from './ThemePreview.jsx';

const surfaceCopy = [
  ['Colors', 'Background, cards, text, and accent. Nothing else.'],
  ['Typography', 'A font from the approved list (Inter, Arial, or Georgia).'],
  ['Spacing', 'Compact or comfortable padding on lists and pages.'],
];

export function ThemeDetailPage() {
  const { id } = useParams();
  const { appearance, loading, saving, install, previewing, startPreview, stopPreview } = useAppearance();
  const [theme, setTheme] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    setTheme(null);
    setError('');
    api(routes.theme(id))
      .then((data) => { if (active) setTheme(data); })
      .catch((caught) => {
        if (active) {
          setError(caught.code === 'THEME_NOT_FOUND'
            ? 'This gallery theme is no longer listed.'
            : caught.message);
        }
      });
    return () => { active = false; };
  }, [id]);

  async function runInstall() {
    if (!theme) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await install(theme.id);
      setNotice(`${theme.name} is now your appearance.`);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setBusy(false);
    }
  }

  return <section className="themes-page">
    <Link to="/themes">← Themes</Link>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {!theme && !error && <p>Loading theme…</p>}
    {theme && <>
      <ThemePreviewBanner previewing={previewing} busy={busy || saving}
        onInstall={runInstall} onCancel={stopPreview} />
      <h1>{theme.name}</h1>
      <p className="muted">By {theme.creatorName || 'Community member'} · {new Date(theme.createdAt).toLocaleDateString()}</p>
      <ThemeSample settings={theme.settings} />
      <section className="theme-section" aria-labelledby="theme-surfaces-title">
        <h2 id="theme-surfaces-title">What this theme can change</h2>
        <ul className="theme-surface-list">
          {surfaceCopy.map(([title, detail]) => <li key={title}><strong>{title}.</strong> {detail}</li>)}
        </ul>
        <p>A theme cannot read your files, passwords, or account email. It only sets approved colors, font, and spacing.</p>
        <dl className="theme-token-list">
          {Object.entries(colorLabels).map(([key, label]) => <div key={key}>
            <dt>{label}</dt>
            <dd><span className="theme-swatch" style={{ background: theme.settings.colors[key] }} /> {theme.settings.colors[key]}</dd>
          </div>)}
          <div><dt>Font</dt><dd>{theme.settings.font}</dd></div>
          <div><dt>Spacing</dt><dd>{theme.settings.spacing}</dd></div>
        </dl>
      </section>
      <div className="theme-actions">
        <button type="button" className="btn-ghost" disabled={busy || loading || saving} onClick={() => startPreview(theme)}>Preview</button>
        <button type="button" disabled={busy || loading || saving} onClick={runInstall}>
          {appearance.sourceThemeId === theme.id ? 'Install again' : 'Install theme'}
        </button>
      </div>
    </>}
  </section>;
}
