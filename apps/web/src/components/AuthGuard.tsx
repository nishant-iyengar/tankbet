import { useAppAuth } from '../auth/useAppAuth';
import { Navigate, Outlet } from 'react-router-dom';

export function AuthGuard(): React.JSX.Element {
  const { isSignedIn } = useAppAuth();

  if (!isSignedIn) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
