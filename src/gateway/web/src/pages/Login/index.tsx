import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Command, LogIn, Loader2, AlertCircle, ExternalLink } from 'lucide-react';
import { login } from '../../auth';

export function LoginPage() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [ssoEnabled, setSsoEnabled] = useState(false);

    // Check SSO availability and URL error params
    useEffect(() => {
        const urlError = searchParams.get('error');
        if (urlError) {
            setError(decodeURIComponent(urlError));
        }

        fetch('/api/sso/config')
            .then(r => r.json())
            .then(data => setSsoEnabled(data.enabled))
            .catch(() => {});
    }, [searchParams]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const result = await login({ username, password });
            if (result.ok) {
                navigate('/');
            } else {
                setError(result.error || 'Login failed');
            }
        } catch {
            setError('Network error');
        } finally {
            setLoading(false);
        }
    };

    const handleSsoLogin = () => {
        window.location.href = '/auth/sso';
    };

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
            <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden">
                {/* Header with Logo */}
                <div className="p-8 pb-6 flex flex-col items-center text-center">
                    <div className="w-16 h-16 bg-primary-50 rounded-2xl flex items-center justify-center mb-6 text-primary-600">
                        <Command className="w-8 h-8" />
                    </div>
                    <h1 className="text-2xl font-bold text-gray-900 mb-2">Welcome Back</h1>
                    <p className="text-sm text-gray-500">
                        Sign in to access your Siclaw workspace
                    </p>
                </div>

                {/* Login Form */}
                <form onSubmit={handleSubmit} className="p-8 pt-0 space-y-4">
                    {error && (
                        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-100 rounded-lg text-red-600 text-sm">
                            <AlertCircle className="w-4 h-4 flex-shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    {/* SSO Login Button */}
                    {ssoEnabled && (
                        <>
                            <button
                                type="button"
                                onClick={handleSsoLogin}
                                className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-primary-600 text-white rounded-xl hover:bg-primary-700 transition-all font-medium shadow-lg shadow-primary-100"
                            >
                                <ExternalLink className="w-5 h-5" />
                                <span>Sign in with SSO</span>
                            </button>

                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <span className="w-full border-t border-gray-100" />
                                </div>
                                <div className="relative flex justify-center text-xs uppercase">
                                    <span className="bg-white px-2 text-gray-400">or sign in with password</span>
                                </div>
                            </div>
                        </>
                    )}

                    <div className="space-y-2">
                        <label htmlFor="username" className="block text-sm font-medium text-gray-700">
                            Username
                        </label>
                        <input
                            id="username"
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                            placeholder="Enter your username"
                            required
                            autoFocus={!ssoEnabled}
                            disabled={loading}
                        />
                    </div>

                    <div className="space-y-2">
                        <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                            Password
                        </label>
                        <input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-all"
                            placeholder="Enter your password"
                            required
                            disabled={loading}
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading || !username || !password}
                        className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-gray-900 text-white rounded-xl hover:bg-gray-800 transition-all font-medium shadow-lg shadow-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? (
                            <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                            <LogIn className="w-5 h-5" />
                        )}
                        <span>{loading ? 'Signing in...' : 'Sign In'}</span>
                    </button>

                    {!ssoEnabled && (
                        <>
                            <div className="relative">
                                <div className="absolute inset-0 flex items-center">
                                    <span className="w-full border-t border-gray-100" />
                                </div>
                                <div className="relative flex justify-center text-xs uppercase">
                                    <span className="bg-white px-2 text-gray-400">Restricted Access</span>
                                </div>
                            </div>

                            <p className="text-center text-xs text-gray-400 leading-relaxed">
                                Default credentials: admin / admin<br />
                                Contact administrator for custom accounts.
                            </p>
                        </>
                    )}
                </form>
            </div>

            {/* Footer */}
            <div className="mt-8 text-center text-xs text-gray-400">
                &copy; 2025 Siclaw. All rights reserved.
            </div>
        </div>
    );
}
