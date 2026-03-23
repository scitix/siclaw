import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWebSocket } from '../../hooks/useWebSocket';
import { rpcJoinByToken } from './skillsData';

export function JoinSkillSetPage() {
    const { token } = useParams();
    const navigate = useNavigate();
    const { sendRpc, isConnected } = useWebSocket();
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!token || !isConnected) return;

        rpcJoinByToken(sendRpc, token).then(result => {
            navigate(`/skills/sets/${result.setId}`, { replace: true });
        }).catch((err: any) => {
            setError(err.message || 'Invalid or expired invite link');
        });
    }, [token, isConnected, sendRpc, navigate]);

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm text-gray-500">{error}</p>
                <button
                    onClick={() => navigate('/skills?tab=myskills')}
                    className="text-sm text-gray-600 hover:text-gray-900 underline"
                >
                    Go to Skills
                </button>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center h-full">
            <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
        </div>
    );
}
