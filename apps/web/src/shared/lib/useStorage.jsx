import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { routes } from '../../../../../packages/shared/index.js';
import { api } from './api.js';

export const WARN_THRESHOLD = 0.9;

const StorageContext = createContext(null);

export function StorageProvider({ children }) {
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
  return <StorageContext.Provider value={{ usage, error, refreshUsage }}>{children}</StorageContext.Provider>;
}

export function useStorage() {
  const value = useContext(StorageContext);
  if (!value) throw new Error('useStorage requires StorageProvider');
  return value;
}
