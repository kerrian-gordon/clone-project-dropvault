import { WARN_THRESHOLD } from '../lib/useStorage.js';

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function StorageMeter({ usage, error }) {
  if (error) return <p className="error" role="status">Storage usage unavailable: {error}</p>;
  if (!usage) return <p className="muted">Loading storage usage…</p>;
  const ratio = usage.limitBytes > 0 ? usage.usedBytes / usage.limitBytes : 1;
  const percent = Math.min(100, Math.max(0, ratio * 100));
  return <div className={`storage-meter${ratio >= WARN_THRESHOLD ? ' warn' : ''}${ratio >= 1 ? ' full' : ''}`}>
    <div className="meter-bar" role="progressbar" aria-label="Storage used" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className="meter-fill" style={{ width: `${percent}%` }} />
    </div>
    <p className="meter-label">{formatBytes(usage.usedBytes)} of {formatBytes(usage.limitBytes)} used · {usage.tier} plan
      {ratio >= 1 ? <strong> · Storage full — delete files to upload more</strong> : ratio >= WARN_THRESHOLD ? <strong> · Almost full</strong> : null}
    </p>
  </div>;
}
