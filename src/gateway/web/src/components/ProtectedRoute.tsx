
import { Navigate, Outlet } from 'react-router-dom';
import { getAuth } from '../auth';

export const ProtectedRoute = () => {
    const { isAuthenticated } = getAuth();

    if (!isAuthenticated) {
        return <Navigate to="/login" replace />;
    }

    return <Outlet />;
};
