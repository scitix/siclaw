import type { SkillCallStats } from './hooks/useMetrics';

interface SkillCallsPanelProps {
    topSkills: SkillCallStats[];
}

const SCOPE_STYLES: Record<string, string> = {
    builtin: 'bg-blue-100 text-blue-800',
    global: 'bg-amber-100 text-amber-800',
    personal: 'bg-purple-100 text-purple-800',
};

const SCOPE_LABELS: Record<string, string> = {
    builtin: 'core',
    global: 'global',
    personal: 'personal',
};

function ScopeBadge({ scope }: { scope: string }) {
    return (
        <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${SCOPE_STYLES[scope] ?? 'bg-gray-100 text-gray-600'}`}
        >
            {SCOPE_LABELS[scope] ?? scope}
        </span>
    );
}

export function SkillCallsPanel({ topSkills }: SkillCallsPanelProps) {
    const totalCalls = topSkills.reduce((s, t) => s + t.total, 0);
    const maxTotal = topSkills.length > 0 ? topSkills[0].total : 0;

    // Scope aggregation for distribution bar
    const byScope = { builtin: 0, global: 0, personal: 0 };
    for (const s of topSkills) {
        if (s.scope in byScope) byScope[s.scope as keyof typeof byScope] += s.total;
    }

    return (
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between mb-4">
                <div className="text-sm font-semibold text-gray-900">Skill Calls Top 10</div>
                <div className="text-xs text-gray-400">{totalCalls} total</div>
            </div>

            {topSkills.length === 0 ? (
                <div className="text-sm text-gray-400 text-center py-8">No skill calls yet</div>
            ) : (
                <>
                    <div className="space-y-2">
                        {topSkills.map((skill) => {
                            const pct = maxTotal > 0 ? (skill.total / maxTotal) * 100 : 0;
                            return (
                                <div key={skill.skillName} className="flex items-center gap-3">
                                    <div className="w-32 truncate font-mono text-xs text-gray-600" title={skill.skillName}>
                                        {skill.skillName}
                                    </div>
                                    <div className="flex-1 bg-gray-100 rounded-md h-6 relative overflow-hidden">
                                        <div
                                            className="absolute inset-y-0 left-0 bg-purple-100 rounded-md"
                                            style={{ width: `${pct}%` }}
                                        />
                                        <div className="absolute inset-0 flex items-center px-2">
                                            <span className="text-xs font-medium text-purple-700">{skill.total}</span>
                                            {skill.error > 0 && (
                                                <span className="text-xs text-red-400 ml-1">{skill.error} err</span>
                                            )}
                                            <span className="ml-auto">
                                                <ScopeBadge scope={skill.scope} />
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Scope distribution bar */}
                    <div className="mt-4 pt-3 border-t border-gray-100">
                        <div className="flex items-center gap-3 text-xs">
                            <span className="text-gray-400">By scope:</span>
                            {byScope.builtin > 0 && (
                                <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-blue-300" />
                                    core <span className="font-medium text-gray-700">{byScope.builtin}</span>
                                </span>
                            )}
                            {byScope.global > 0 && (
                                <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-amber-300" />
                                    global <span className="font-medium text-gray-700">{byScope.global}</span>
                                </span>
                            )}
                            {byScope.personal > 0 && (
                                <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-purple-300" />
                                    personal <span className="font-medium text-gray-700">{byScope.personal}</span>
                                </span>
                            )}
                        </div>
                        {totalCalls > 0 && (
                            <div className="flex h-1.5 mt-2 rounded-full overflow-hidden bg-gray-100">
                                {byScope.builtin > 0 && (
                                    <div className="bg-blue-300" style={{ width: `${(byScope.builtin / totalCalls) * 100}%` }} />
                                )}
                                {byScope.global > 0 && (
                                    <div className="bg-amber-300" style={{ width: `${(byScope.global / totalCalls) * 100}%` }} />
                                )}
                                {byScope.personal > 0 && (
                                    <div className="bg-purple-300" style={{ width: `${(byScope.personal / totalCalls) * 100}%` }} />
                                )}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
