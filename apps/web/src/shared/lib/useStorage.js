import { useCallback, useEffect, useState } from 'react';
import { routes } from '../../../../../packages/shared/index.js';
import { api } from './api.js';

/** Warn at 90% full — shared rule used by meter and upload gating. */
export const WARN_THRESHOLD = 0.9;

export function useStorage() {
  const [usage, setUsage] = useState(null);

  const refreshUsage = useCallback(() => {
    api(routes.usage)
      .then(setUsage)
      .catch(() => {}); // meter stays hidden on auth failure or network error
  }, []);

  useEffect(() => { refreshUsage(); }, [refreshUsage]);

  return { usage, refreshUsage };
}
