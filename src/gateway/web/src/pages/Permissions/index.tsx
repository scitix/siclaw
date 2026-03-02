import { useState, useEffect, useRef } from 'react';
import { Shield, Loader2, ShieldCheck, ShieldX, Plus, KeyRound, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWebSocket } from '../../hooks/useWebSocket';
import { getCurrentUser } from '../../auth';

interface UserPermission {
    id: string;
    username: string;
    name: string | null;
    permissions: string[];
    isAdmin: boolean;
    testOnly: boolean;
    ssoUser: boolean;
}

export function PermissionsPage() {
    const { sendRpc, isConnected } = useWebSocket();
    const currentUser = getCurrentUser();
    const isAdmin = currentUser?.username === 'admin';

    const [users, setUsers] = useState<UserPermission[]>([]);
    const [loading, setLoading] = useState(true);
    const [toggling, setToggling] = useState<string | null>(null);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [resetPasswordUserId, setResetPasswordUserId] = useState<string | null>(null);

    const loadUsers = async () => {
        try {
            const result = await sendRpc<{ users: UserPermission[] }>('permission.listUsers');
            setUsers(result.users);
        } catch (err) {
            console.error('[Permissions] Failed to load users:', err);
        } finally {
            setLoading(false);
        }
    };

    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (isConnected && isAdmin && !hasLoadedRef.current) {
            hasLoadedRef.current = true;
            loadUsers();
        }
    }, [isConnected]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleToggle = async (user: UserPermission, permission: string) => {
        const hasPermission = user.permissions.includes(permission);
        setToggling(user.id);
        try {
            if (hasPermission) {
                await sendRpc('permission.revoke', { userId: user.id, permission });
            } else {
                await sendRpc('permission.grant', { userId: user.id, permission });
            }
            await loadUsers();
        } catch (err) {
            console.error('[Permissions] Toggle failed:', err);
        } finally {
            setToggling(null);
        }
    };

    const handleToggleTestOnly = async (user: UserPermission) => {
        setToggling(user.id);
        try {
            await sendRpc('user.setTestOnly', { userId: user.id, testOnly: !user.testOnly });
            await loadUsers();
        } catch (err) {
            console.error('[Permissions] Toggle testOnly failed:', err);
        } finally {
            setToggling(null);
        }
    };

    if (!isAdmin) {
        return (
            <div className="h-full flex items-center justify-center">
                <div className="text-center">
                    <ShieldX className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                    <h2 className="text-lg font-semibold text-gray-900 mb-1">Admin access required</h2>
                    <p className="text-sm text-gray-500">Only administrators can manage permissions.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full bg-white flex flex-col">
            <header className="h-16 flex items-center justify-between px-6 bg-white sticky top-0 z-10 border-b border-gray-100">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary-50 rounded-lg">
                        <Shield className="w-5 h-5 text-primary-600" />
                    </div>
                    <div>
                        <h1 className="text-lg font-bold text-gray-900">Permissions</h1>
                        <p className="text-xs text-gray-500">Manage user permissions and access control</p>
                    </div>
                </div>
                <button
                    onClick={() => setShowCreateDialog(true)}
                    className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Create Intern
                </button>
            </header>

            <div className="flex-1 overflow-y-auto p-8">
                <div className="max-w-4xl mx-auto">
                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                        </div>
                    ) : (
                        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-gray-100 bg-gray-50/50">
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">User</th>
                                        <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Username</th>
                                        <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">SSO</th>
                                        <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Test Only</th>
                                        <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Skill Reviewer</th>
                                        <th className="text-center px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {users.map((user) => (
                                        <tr key={user.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                                            <td className="px-6 py-4">
                                                <div className="flex items-center gap-3">
                                                    <div className={cn(
                                                        "w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold",
                                                        user.isAdmin
                                                            ? "bg-primary-100 text-primary-700"
                                                            : "bg-gray-100 text-gray-600"
                                                    )}>
                                                        {(user.name || user.username).charAt(0).toUpperCase()}
                                                    </div>
                                                    <span className="text-sm font-medium text-gray-900">
                                                        {user.name || user.username}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-6 py-4">
                                                <span className="text-sm text-gray-500">{user.username}</span>
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                {user.ssoUser ? (
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-xs font-medium">
                                                        SSO
                                                    </span>
                                                ) : (
                                                    <span className="text-xs text-gray-300">-</span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                {user.isAdmin ? (
                                                    <span className="text-xs text-gray-300">-</span>
                                                ) : (
                                                    <button
                                                        onClick={() => handleToggleTestOnly(user)}
                                                        disabled={toggling === user.id}
                                                        className="inline-flex items-center justify-center"
                                                    >
                                                        {toggling === user.id ? (
                                                            <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                                        ) : (
                                                            <div className={cn(
                                                                "relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer",
                                                                user.testOnly ? "bg-amber-500" : "bg-gray-200"
                                                            )}>
                                                                <span className={cn(
                                                                    "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-in-out",
                                                                    user.testOnly ? "translate-x-4" : "translate-x-0"
                                                                )} />
                                                            </div>
                                                        )}
                                                    </button>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                {user.isAdmin ? (
                                                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-medium">
                                                        <ShieldCheck className="w-3 h-3" />
                                                        Always
                                                    </span>
                                                ) : (
                                                    <button
                                                        onClick={() => handleToggle(user, 'skill_reviewer')}
                                                        disabled={toggling === user.id}
                                                        className="inline-flex items-center justify-center"
                                                    >
                                                        {toggling === user.id ? (
                                                            <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                                                        ) : (
                                                            <div className={cn(
                                                                "relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out cursor-pointer",
                                                                user.permissions.includes('skill_reviewer')
                                                                    ? "bg-green-500"
                                                                    : "bg-gray-200"
                                                            )}>
                                                                <span className={cn(
                                                                    "pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-in-out",
                                                                    user.permissions.includes('skill_reviewer')
                                                                        ? "translate-x-4"
                                                                        : "translate-x-0"
                                                                )} />
                                                            </div>
                                                        )}
                                                    </button>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-center">
                                                {!user.isAdmin && !user.ssoUser && (
                                                    <button
                                                        onClick={() => setResetPasswordUserId(user.id)}
                                                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                                                        title="Reset Password"
                                                    >
                                                        <KeyRound className="w-3 h-3" />
                                                        Reset Pwd
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {showCreateDialog && (
                <CreateInternDialog
                    sendRpc={sendRpc}
                    onClose={() => setShowCreateDialog(false)}
                    onCreated={loadUsers}
                />
            )}

            {resetPasswordUserId && (
                <ResetPasswordDialog
                    userId={resetPasswordUserId}
                    sendRpc={sendRpc}
                    onClose={() => setResetPasswordUserId(null)}
                />
            )}
        </div>
    );
}

function CreateInternDialog({
    sendRpc,
    onClose,
    onCreated,
}: {
    sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
    onClose: () => void;
    onCreated: () => void;
}) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!username || !password) return;
        setSubmitting(true);
        setError('');
        try {
            await sendRpc('user.create', { username, password, testOnly: true });
            onCreated();
            onClose();
        } catch (err: any) {
            setError(err?.message || 'Failed to create user');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Create Intern Account</h3>
                    <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                        <input
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            placeholder="intern_username"
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                            placeholder="Password"
                            required
                        />
                    </div>
                    <p className="text-xs text-gray-500">This account will be created with <span className="font-medium text-amber-600">Test Only</span> access.</p>
                    {error && <p className="text-xs text-red-600">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">Cancel</button>
                        <button type="submit" disabled={submitting} className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50">
                            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

function ResetPasswordDialog({
    userId,
    sendRpc,
    onClose,
}: {
    userId: string;
    sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
    onClose: () => void;
}) {
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!password) return;
        setSubmitting(true);
        setError('');
        try {
            await sendRpc('user.resetPassword', { userId, password });
            setSuccess(true);
            setTimeout(onClose, 1500);
        } catch (err: any) {
            setError(err?.message || 'Failed to reset password');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Reset Password</h3>
                    <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                {success ? (
                    <p className="text-sm text-green-600 font-medium">Password reset successfully.</p>
                ) : (
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                                placeholder="New password"
                                required
                            />
                        </div>
                        {error && <p className="text-xs text-red-600">{error}</p>}
                        <div className="flex justify-end gap-2">
                            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">Cancel</button>
                            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:opacity-50">
                                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Reset'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
