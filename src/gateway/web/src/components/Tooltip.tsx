import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

interface TooltipProps {
    content: string;
    children: React.ReactNode;
    position?: 'top' | 'bottom' | 'left' | 'right';
    delay?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
    content,
    children,
    position = 'top',
    delay = 0.2
}) => {
    const [isVisible, setIsVisible] = useState(false);
    const triggerRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState({ top: 0, left: 0 });

    useEffect(() => {
        if (isVisible && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            let top = 0;
            let left = 0;

            const offset = 8; // gap between element and tooltip

            switch (position) {
                case 'top':
                    top = rect.top - offset;
                    left = rect.left + rect.width / 2;
                    break;
                case 'bottom':
                    top = rect.bottom + offset;
                    left = rect.left + rect.width / 2;
                    break;
                case 'left':
                    top = rect.top + rect.height / 2;
                    left = rect.left - offset;
                    break;
                case 'right':
                    top = rect.top + rect.height / 2;
                    left = rect.right + offset;
                    break;
            }

            setCoords({ top, left });
        }
    }, [isVisible, position]);

    return (
        <>
            <div
                ref={triggerRef}
                className="relative flex items-center"
                onMouseEnter={() => setIsVisible(true)}
                onMouseLeave={() => setIsVisible(false)}
            >
                {children}
            </div>
            {createPortal(
                <AnimatePresence>
                    {isVisible && (
                        <motion.div
                            initial={{
                                opacity: 0,
                                scale: 0.96,
                                y: position === 'top' ? 4 : position === 'bottom' ? -4 : 0,
                                x: position === 'left' ? 4 : position === 'right' ? -4 : 0,
                                top: coords.top,
                                left: coords.left
                            }}
                            animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
                            exit={{ opacity: 0, scale: 0.96 }}
                            transition={{ duration: 0.15, delay, ease: "easeOut" }}
                            style={{
                                position: 'fixed',
                                top: 0,
                                left: 0,
                                pointerEvents: 'none'
                            }}
                            className="z-[9999]"
                        >
                            <div className={`
                                relative px-3 py-1.5 text-xs font-semibold text-gray-700 bg-white 
                                border border-gray-100 rounded-lg shadow-[0_4px_12px_-2px_rgba(0,0,0,0.08)] 
                                whitespace-nowrap select-none
                                ${position === 'top' ? '-translate-x-1/2 -translate-y-full' : ''}
                                ${position === 'bottom' ? '-translate-x-1/2' : ''}
                                ${position === 'left' ? '-translate-x-full -translate-y-1/2' : ''}
                                ${position === 'right' ? '-translate-y-1/2' : ''}
                            `}>
                                {content}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>,
                document.body
            )}
        </>
    );
};
