import { useCallback, useEffect, useState } from 'react';
import { routes } from '../../../../../packages/shared/index.js';
import { api } from './api.js';

export const WARN_THRESHOLD = 0.9;

export function useStorage() {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');
  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await api(routes.usage));
      setError('');
    } catch (caught) {
      setError(caught.message);
    }
  }, []);
  useEffect(() => { refreshUsage(); }, [refreshUsage]);
  return { usage, error, refreshUsage };
}
