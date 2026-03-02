import { useState, useCallback } from 'react';
import type { TriggerEndpoint } from '../pages/Triggers/triggersData';

export function useTriggers(
  sendRpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>,
) {
  const [triggers, setTriggers] = useState<TriggerEndpoint[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTriggers = useCallback(async () => {
    try {
      const result = await sendRpc<{ triggers: any[] }>('trigger.list');
      setTriggers((result.triggers ?? []).map(t => ({
        ...t,
        icon: t.configJson?.icon || 'zap',
        description: t.configJson?.description || t.name,
      })));
    } catch (err) {
      console.error('[useTriggers] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  const saveTrigger = useCallback(async (trigger: Partial<TriggerEndpoint>) => {
    const result = await sendRpc<{ id: string; secret: string; endpointUrl: string }>('trigger.save', {
      id: trigger.id,
      name: trigger.name,
      type: trigger.type,
      status: trigger.status,
      config: { description: trigger.description, icon: trigger.icon },
    });
    await loadTriggers();
    return result;
  }, [sendRpc, loadTriggers]);

  const deleteTrigger = useCallback(async (id: string) => {
    await sendRpc('trigger.delete', { id });
    await loadTriggers();
  }, [sendRpc, loadTriggers]);

  return { triggers, loading, loadTriggers, saveTrigger, deleteTrigger };
}
