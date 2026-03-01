import { createContext, useState, useCallback, useEffect, type ReactNode } from 'react';

const DEV_AUTH_KEY = 'dev-auth-user';

export interface DevUser {
  id: string;
  clerkId: string;
  username: string;
  phoneNumber: string;
}

export interface DevAuthState {
  isSignedIn: boolean;
  isLoaded: boolean;
  userId: string | null;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
  user: { phoneNumbers: Array<{ phoneNumber: string }> } | null;
  devUser: DevUser | null;
  setDevUser: (user: DevUser) => void;
}

export const DevAuthContext = createContext<DevAuthState | null>(null);

function loadDevUser(): DevUser | null {
  try {
    const stored = localStorage.getItem(DEV_AUTH_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as DevUser;
  } catch {
    return null;
  }
}

export function DevAuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [devUser, setDevUserState] = useState<DevUser | null>(loadDevUser);

  // Sync across tabs
  useEffect(() => {
    function onStorage(e: StorageEvent): void {
      if (e.key === DEV_AUTH_KEY) {
        setDevUserState(e.newValue ? (JSON.parse(e.newValue) as DevUser) : null);
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setDevUser = useCallback((user: DevUser) => {
    localStorage.setItem(DEV_AUTH_KEY, JSON.stringify(user));
    setDevUserState(user);
  }, []);

  const signOut = useCallback(async () => {
    localStorage.removeItem(DEV_AUTH_KEY);
    setDevUserState(null);
  }, []);

  const getToken = useCallback(async () => {
    if (!devUser) return null;
    return `DevToken ${devUser.clerkId}`;
  }, [devUser]);

  const state: DevAuthState = {
    isSignedIn: devUser !== null,
    isLoaded: true,
    userId: devUser?.clerkId ?? null,
    getToken,
    signOut,
    user: devUser
      ? { phoneNumbers: [{ phoneNumber: devUser.phoneNumber }] }
      : null,
    devUser,
    setDevUser,
  };

  return (
    <DevAuthContext.Provider value={state}>
      {children}
    </DevAuthContext.Provider>
  );
}
