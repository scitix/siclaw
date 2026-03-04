import { useState, useCallback } from 'react';
import type { CronJob } from '../pages/Cron/cronData';

export function useCronJobs(
  sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>,
) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setError(null);
    try {
      const result = await sendRpc<{ jobs: CronJob[] }>('cron.list');
      setJobs(result.jobs ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[useCronJobs] Failed to load:', msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  const saveJob = useCallback(async (job: Partial<CronJob>) => {
    const result = await sendRpc<{ id: string; name: string; schedule: string; status: string }>(
      'cron.save',
      {
        id: job.id,
        name: job.name,
        description: job.description,
        schedule: job.schedule,
        skillId: job.skillId,
        status: job.status,
        envId: job.envId ?? null,
      },
    );
    await loadJobs();
    return result;
  }, [sendRpc, loadJobs]);

  const deleteJob = useCallback(async (id: string) => {
    await sendRpc('cron.delete', { id });
    await loadJobs();
  }, [sendRpc, loadJobs]);

  return { jobs, loading, error, loadJobs, saveJob, deleteJob };
}
