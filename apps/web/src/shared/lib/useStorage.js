import { useCallback, useEffect, useState } from 'react';
import { routes } from '../../../../../packages/shared/index.js';
import { api } from './api.js';

export const WARN_THRESHOLD = 0.9;

export function useStorage() {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');
  const refreshUsage = useCallback(async () => {
    try {
      const latest = await api(routes.usage);
      setUsage(latest);
      setError('');
      return latest;
    } catch (caught) {
      setError(caught.message);
      return null;
    }
  }, []);
  useEffect(() => { refreshUsage(); }, [refreshUsage]);
  return { usage, error, refreshUsage };
}
