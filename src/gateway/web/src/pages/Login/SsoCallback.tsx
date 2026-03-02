import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

/**
 * SSO Callback landing page.
 *
 * The backend redirects here after a successful OAuth2 flow with
 * ?token=xxx&userId=xxx&username=xxx in the URL.
 * We save the auth state to localStorage and redirect to /.
 */
export function SsoCallback() {
    const navigate = useNavigate();
    const [params] = useSearchParams();

    useEffect(() => {
        const token = params.get('token');
        const userId = params.get('userId');
        const username = params.get('username');

        if (token && userId && username) {
            // Save auth state (same format as regular login)
            const authState = {
                isAuthenticated: true,
                token,
                user: { id: userId, username },
            };
            localStorage.setItem('siclaw_auth', JSON.stringify(authState));
            navigate('/', { replace: true });
        } else {
            // Missing params — back to login
            navigate('/login?error=sso_callback_failed', { replace: true });
        }
    }, [params, navigate]);

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400 mb-4" />
            <p className="text-sm text-gray-500">Completing sign in...</p>
        </div>
    );
}
