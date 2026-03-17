import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

/**
 * SSO Callback landing page.
 *
 * The backend redirects here after a successful OAuth2 flow with
 * ?token=xxx&userId=xxx&username=xxx in the URL.
 * We save the auth state to localStorage and redirect to /.
 *
 * Uses window.location.href instead of React Router navigate() to ensure
 * a full page reload — this avoids stale React state from the previous
 * session interfering with the newly authenticated state.
 */
export function SsoCallback() {
    const [params] = useSearchParams();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const token = params.get('token');
        const userId = params.get('userId');
        const username = params.get('username');
        const errorParam = params.get('error');

        if (errorParam) {
            setError(errorParam);
            setTimeout(() => { window.location.href = '/login?error=' + encodeURIComponent(errorParam); }, 3000);
            return;
        }

        if (token && userId && username) {
            // Save auth state (same format as regular login)
            const authState = {
                isAuthenticated: true,
                token,
                user: { id: userId, username },
            };
            localStorage.setItem('siclaw_auth', JSON.stringify(authState));
            // Full page reload to ensure clean React state
            window.location.href = '/';
        } else {
            // Missing params — show error briefly, then redirect
            setError('SSO callback missing required parameters');
            setTimeout(() => { window.location.href = '/login?error=sso_callback_failed'; }, 3000);
        }
    }, [params]);

    if (error) {
        return (
            <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
                <p className="text-sm text-red-500 mb-2">{error}</p>
                <p className="text-xs text-gray-400">Redirecting to login...</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400 mb-4" />
            <p className="text-sm text-gray-500">Completing sign in...</p>
        </div>
    );
}
