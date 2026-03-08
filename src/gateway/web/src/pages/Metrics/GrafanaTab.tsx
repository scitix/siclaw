import { BarChart3 } from 'lucide-react';
import { Link } from 'react-router-dom';

interface GrafanaTabProps {
    grafanaUrl: string | null;
}

export function GrafanaTab({ grafanaUrl }: GrafanaTabProps) {
    if (!grafanaUrl) {
        return (
            <div className="flex-1 flex items-center justify-center text-gray-400">
                <div className="text-center">
                    <BarChart3 className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <div className="text-lg font-medium text-gray-500 mb-1">Grafana</div>
                    <div className="text-sm">
                        Configure Grafana URL in{' '}
                        <Link to="/settings/system" className="text-primary-600 hover:underline">
                            System Settings
                        </Link>{' '}
                        to enable.
                    </div>
                </div>
            </div>
        );
    }

    return (
        <iframe
            src={grafanaUrl}
            className="flex-1 w-full border-0"
            allow="fullscreen"
            title="Grafana Dashboard"
        />
    );
}
