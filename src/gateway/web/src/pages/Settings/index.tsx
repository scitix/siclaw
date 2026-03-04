import {
    User,
    LogOut,
    Search,
    Hash,
    KeyRound,
    Loader2,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { getUser, updateUser, rpcUpdateProfile } from './userData';
import { logout, getCurrentUser } from '../../auth';
import { EditProfileDialog } from '../../components/EditProfileDialog';
import { useWebSocket } from '../../hooks/useWebSocket';

export function SettingsPage() {
    const [user, setUser] = useState(getUser());
    const [isEditOpen, setIsEditOpen] = useState(false);
    const { sendRpc, isConnected } = useWebSocket();
    const authUser = getCurrentUser();
    const [isSsoUser, setIsSsoUser] = useState(true); // default true to hide form until loaded

    // Load SSO status
    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (!isConnected || hasLoadedRef.current) return;
        hasLoadedRef.current = true;
        sendRpc<{ ssoUser?: boolean }>('permission.mine')
            .then((result) => setIsSsoUser(result.ssoUser ?? false))
            .catch(() => {});
    }, [isConnected, sendRpc]);

    // Listen for updates (though in this component we trigger them mostly)
    useEffect(() => {
        const handleUpdate = () => {
            const u = getUser();
            setUser(u);
        };
        window.addEventListener('user-profile-updated', handleUpdate);
        return () => window.removeEventListener('user-profile-updated', handleUpdate);
    }, []);

    const handleSaveProfile = async (updates: any) => {
        updateUser(updates);
        try {
            await rpcUpdateProfile(sendRpc, updates);
        } catch {
            // local update already applied
        }
    };

    return (
        <div className="h-full bg-white flex flex-col">
            <EditProfileDialog
                isOpen={isEditOpen}
                onClose={() => setIsEditOpen(false)}
                user={user}
                onSave={handleSaveProfile}
            />

            {/* Header */}
            <header className="h-16 flex items-center justify-end px-6 bg-white sticky top-0 z-10">
                <div className="relative group">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-primary-500 transition-colors" />
                    <input
                        type="text"
                        placeholder="Search settings..."
                        className="pl-9 pr-3 py-1.5 bg-gray-50 border-none rounded-md text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-200 w-48 transition-all"
                    />
                </div>
            </header>

            {/* Content */}
            <div className="flex-1 overflow-y-auto bg-white p-8">
                <div className="max-w-3xl mx-auto space-y-6">

                    {/* Profile Header Card */}
                    <div className="bg-white rounded-xl border border-gray-200 p-6 flex items-center gap-6 shadow-sm">
                        <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center border border-gray-200">
                            <User className="w-10 h-10 text-gray-400" />
                        </div>
                        <div className="flex-1">
                            <div className="flex items-center gap-3">
                                <h2 className="text-xl font-bold text-gray-900">{user.name}</h2>
                            </div>
                            <p className="text-gray-500 text-sm mt-1">{user.role}</p>
                            {authUser && (
                                <div className="flex items-center gap-1.5 mt-2 text-xs text-gray-400">
                                    <Hash className="w-3.5 h-3.5" />
                                    <span className="font-mono">{authUser.id}</span>
                                </div>
                            )}
                        </div>
                        <button
                            onClick={() => setIsEditOpen(true)}
                            className="px-4 py-2 bg-white border border-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm"
                        >
                            Edit Profile
                        </button>
                    </div>

                    {/* Change Password — only for non-SSO users */}
                    {!isSsoUser && (
                        <div className="space-y-3">
                            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1">Security</h3>
                            <ChangePasswordForm sendRpc={sendRpc} />
                        </div>
                    )}

                    {/* Danger Zone */}
                    <div className="pt-6">
                        <button
                            onClick={logout}
                            className="w-full p-3 rounded-lg border border-red-100 bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-colors flex items-center justify-center gap-2"
                        >
                            <LogOut className="w-4 h-4" />
                            Sign Out
                        </button>
                    </div>

                    <div className="text-center text-xs text-gray-400 pb-8">
                        Siclaw v0.1.0
                    </div>
                </div>
            </div>
        </div>
    );
}

function ChangePasswordForm({
    sendRpc,
}: {
    sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
}) {
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccess(false);

        if (newPassword !== confirmPassword) {
            setError('New passwords do not match');
            return;
        }
        if (newPassword.length < 4) {
            setError('Password must be at least 4 characters');
            return;
        }

        setSubmitting(true);
        try {
            await sendRpc('user.changePassword', { oldPassword, newPassword });
            setSuccess(true);
            setOldPassword('');
            setNewPassword('');
            setConfirmPassword('');
        } catch (err: any) {
            setError(err?.message || 'Failed to change password');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <div className="flex items-center gap-3 mb-4">
                <KeyRound className="w-5 h-5 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Change Password</span>
            </div>
            <form onSubmit={handleSubmit} className="space-y-3">
                <input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="Current password"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    required
                />
                <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    required
                />
                <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm new password"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                    required
                />
                {error && <p className="text-xs text-red-600">{error}</p>}
                {success && <p className="text-xs text-green-600">Password changed successfully.</p>}
                <div className="flex justify-end">
                    <button
                        type="submit"
                        disabled={submitting}
                        className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50 inline-flex items-center gap-2"
                    >
                        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                        Change Password
                    </button>
                </div>
            </form>
        </div>
    );
}
