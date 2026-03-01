import { useContext, useCallback } from 'react';
import { useAuth, useClerk, useUser } from '@clerk/clerk-react';
import { DevAuthContext } from './DevAuthContext';

const IS_DEV = import.meta.env.DEV;

/**
 * Drop-in replacement for Clerk's useAuth().
 * In dev mode with an active dev user, returns dev auth state.
 * Otherwise delegates to Clerk.
 */
export function useAppAuth(): {
  isSignedIn: boolean;
  isLoaded: boolean;
  userId: string | null | undefined;
  getToken: () => Promise<string | null>;
} {
  const devAuth = useContext(DevAuthContext);
  const clerkAuth = useAuth();

  if (IS_DEV && devAuth?.isSignedIn) {
    return {
      isSignedIn: devAuth.isSignedIn,
      isLoaded: devAuth.isLoaded,
      userId: devAuth.userId,
      getToken: devAuth.getToken,
    };
  }

  return {
    isSignedIn: clerkAuth.isSignedIn ?? false,
    isLoaded: clerkAuth.isLoaded,
    userId: clerkAuth.userId,
    getToken: clerkAuth.getToken,
  };
}

/**
 * Drop-in replacement for Clerk's useClerk().
 * Returns signOut that works for both dev and Clerk auth.
 */
export function useAppClerk(): { signOut: () => Promise<void> } {
  const devAuth = useContext(DevAuthContext);
  const clerk = useClerk();

  const clerkSignOut = useCallback(async () => {
    await clerk.signOut();
  }, [clerk]);

  if (IS_DEV && devAuth?.isSignedIn) {
    return { signOut: devAuth.signOut };
  }

  return { signOut: clerkSignOut };
}

/**
 * Drop-in replacement for Clerk's useUser().
 * Returns a user-like object for dev auth or Clerk user.
 */
interface AppUser {
  phoneNumbers: Array<{ phoneNumber: string }>;
  primaryEmailAddress?: { emailAddress: string };
  fullName?: string | null;
  username?: string | null;
}

export function useAppUser(): { user: AppUser | null } {
  const devAuth = useContext(DevAuthContext);
  const clerkUser = useUser();

  if (IS_DEV && devAuth?.isSignedIn && devAuth.user) {
    return {
      user: {
        phoneNumbers: devAuth.user.phoneNumbers,
      },
    };
  }

  if (!clerkUser.user) {
    return { user: null };
  }

  return {
    user: {
      phoneNumbers: clerkUser.user.phoneNumbers.map((p) => ({
        phoneNumber: p.phoneNumber,
      })),
      primaryEmailAddress: clerkUser.user.primaryEmailAddress
        ? { emailAddress: clerkUser.user.primaryEmailAddress.emailAddress }
        : undefined,
      fullName: clerkUser.user.fullName,
      username: clerkUser.user.username,
    },
  };
}
