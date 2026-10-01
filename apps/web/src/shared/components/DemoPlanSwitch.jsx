import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../app/AuthContext.jsx';
import { formatBytes } from './StorageMeter.jsx';

export function DemoPlanSwitch({ usage, refreshUsage }) {
  const { user, changePlan, demoPlanSwitchEnabled } = useAuth();
  const dialog = useRef(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const onDemo = user.tier === 'demo';
  const nextTier = onDemo ? 'free' : 'demo';
  const actionLabel = onDemo ? 'Switch to free plan' : 'Switch to demo plan';
  const freeLimit = usage
    ? (usage.tier === 'demo' ? usage.limitBytes / 10 : usage.limitBytes)
    : null;
  const overFreeCap = freeLimit != null && usage.usedBytes >= freeLimit;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  if (!demoPlanSwitchEnabled) return null;

  function close() {
    dialog.current?.close();
    setOpen(false);
    setError('');
  }

  async function confirmSwitch() {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await changePlan(nextTier);
      await refreshUsage();
      close();
    } catch (caught) {
      setError(caught.message);
    } finally {
      setPending(false);
    }
  }

  return <>
    <button type="button" className="btn-ghost sidebar-plan-switch" onClick={() => { setError(''); setOpen(true); }}>
      {actionLabel}
    </button>
    <dialog ref={dialog} className="upgrade-dialog" aria-labelledby="plan-switch-title"
      onClose={() => setOpen(false)} onCancel={(event) => { if (pending) event.preventDefault(); }}>
      <h2 id="plan-switch-title">{actionLabel}</h2>
      {onDemo
        ? <p>This unpaid local switch keeps your files. The storage limit drops to the free cap.</p>
        : <p>This unpaid local switch has no payment step. The demo plan provides ten times the free storage limit.</p>}
      {freeLimit != null && <p className="muted">Free limit: {formatBytes(freeLimit)}. Demo limit: {formatBytes(freeLimit * 10)}.</p>}
      {onDemo && overFreeCap && <p>You are at or over the free cap, so new uploads will be blocked until you delete files or switch back to demo.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn-ghost" disabled={pending} onClick={close}>Cancel</button>
        <button type="button" disabled={pending} onClick={confirmSwitch}>
          {pending ? 'Switching…' : actionLabel}
        </button>
      </div>
    </dialog>
  </>;
}
