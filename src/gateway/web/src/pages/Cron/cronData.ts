export interface CronJob {
    id: string;
    name: string;
    description: string;
    schedule: string; // Cron expression, e.g. "0 9 * * 1-5"
    skillId?: string;
    status: 'active' | 'paused';
    lastRun?: string;
    lastResult?: 'success' | 'failure';
    envId?: string | null;
    envName?: string | null;
}
