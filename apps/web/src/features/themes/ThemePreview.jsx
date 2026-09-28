export const colorLabels = {
  background: 'Background', surface: 'Cards', text: 'Text', accent: 'Accent',
};

export function ThemeSample({ settings }) {
  return <div className="theme-sample" style={{
    background: settings.colors.background, color: settings.colors.text,
    fontFamily: `${settings.font}, sans-serif`,
    padding: settings.spacing === 'compact' ? '0.7rem' : '1.15rem',
  }} aria-hidden="true">
    <div className="theme-sample-card" style={{ background: settings.colors.surface }}>
      <strong>My files</strong>
      <span>Project notes.pdf</span>
      <i style={{ background: settings.colors.accent }} />
    </div>
  </div>;
}

export function ThemePreviewBanner({ previewing, busy, onInstall, onCancel }) {
  if (!previewing) return null;
  return <div className="theme-preview-banner" role="status">
    <strong>Previewing {previewing.name}</strong>
    <span>This view is temporary. Your saved appearance has not changed.</span>
    <div className="theme-actions">
      <button type="button" disabled={busy} onClick={onInstall}>Install this theme</button>
      <button type="button" className="btn-ghost" onClick={onCancel}>Cancel preview</button>
    </div>
  </div>;
}
