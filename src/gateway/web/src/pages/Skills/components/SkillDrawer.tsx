import { X, Check, FileJson, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useState, useEffect } from 'react';


export type Skill = {
    id: number | string;
    name: string;
    description: string;
    type: string;
    icon: any;
    status: string;
    version: string;
    config?: string; // JSON config mock
};

interface SkillDrawerProps {
    skill: Skill | null;
    isOpen: boolean;
    onClose: () => void;
    onSave: (updatedSkill: Skill) => void;
}

export function SkillDrawer({ skill, isOpen, onClose, onSave }: SkillDrawerProps) {
    const [formData, setFormData] = useState<Skill | null>(null);

    useEffect(() => {
        if (skill) {
            setFormData({
                ...skill,
                config: skill.config || JSON.stringify({
                    "timeout": 300,
                    "retries": 3,
                    "log_level": "info",
                    "notifications": true
                }, null, 2)
            });
        }
    }, [skill]);

    const handleSave = () => {
        if (formData) {
            onSave(formData);
            onClose();
        }
    };

    return (
        <AnimatePresence>
            {isOpen && formData && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 transition-opacity"
                    />

                    {/* Drawer */}
                    <motion.div
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-white shadow-2xl flex flex-col"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                            <div>
                                <h2 className="text-lg font-semibold text-gray-900">Configure Skill</h2>
                                <p className="text-xs text-gray-500 mt-0.5">ID: {formData.id}</p>
                            </div>
                            <button
                                onClick={onClose}
                                className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">
                            {/* Basic Info Group */}
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Skill Name</label>
                                    <input
                                        type="text"
                                        value={formData.name}
                                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-500 transition-all font-medium"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Description</label>
                                    <textarea
                                        rows={3}
                                        value={formData.description}
                                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                        className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-100 focus:border-primary-500 transition-all resize-none"
                                    />
                                </div>
                            </div>

                            <hr className="border-gray-100" />

                            {/* Configuration Editor */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-sm font-medium text-gray-700 flex items-center gap-2">
                                        <FileJson className="w-4 h-4 text-gray-400" />
                                        Configuration (JSON)
                                    </label>
                                    <span className="text-xs text-gray-400 font-mono">defaults.json</span>
                                </div>
                                <div className="relative group">
                                    <textarea
                                        rows={12}
                                        value={formData.config}
                                        onChange={(e) => setFormData({ ...formData, config: e.target.value })}
                                        className="w-full px-4 py-3 bg-slate-900 text-slate-50 rounded-xl font-mono text-xs leading-5 focus:outline-none focus:ring-2 focus:ring-primary-500/50 resize-none selection:bg-primary-500/30"
                                    />
                                </div>
                                <p className="mt-2 text-xs text-gray-500">
                                    Edit runtime parameters. These will be hot-reloaded to the agent.
                                </p>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between gap-4">
                            <button className="flex items-center gap-2 px-4 py-2 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg text-sm font-medium transition-colors">
                                <Trash2 className="w-4 h-4" />
                                <span className="hidden sm:inline">Uninstall</span>
                            </button>
                            <div className="flex gap-3">
                                <button
                                    onClick={onClose}
                                    className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg text-sm font-medium transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    className="px-6 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium shadow-sm shadow-primary-200 transition-all flex items-center gap-2"
                                >
                                    <Check className="w-4 h-4" />
                                    Save Changes
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
