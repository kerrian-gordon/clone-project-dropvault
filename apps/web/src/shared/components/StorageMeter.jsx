import { WARN_THRESHOLD } from '../lib/useStorage.js';

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function StorageMeter({ usage }) {
  if (!usage) return null;
  const ratio = usage.usedBytes / usage.limitBytes;
  const pct = Math.min(ratio * 100, 100).toFixed(1);
  const warn = ratio >= WARN_THRESHOLD;
  const full = ratio >= 1;

  return (
    <div className={`storage-meter${warn ? ' warn' : ''}${full ? ' full' : ''}`}>
      <div className="meter-bar" role="progressbar" aria-valuenow={Math.round(ratio * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used">
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="meter-label">
        {formatBytes(usage.usedBytes)} of {formatBytes(usage.limitBytes)} used
        {full && <strong> · Storage full — delete files to upload more</strong>}
        {warn && !full && <strong> · Almost full</strong>}
      </p>
    </div>
  );
}
