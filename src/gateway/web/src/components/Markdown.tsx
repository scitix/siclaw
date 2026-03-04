import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownProps {
    children: string;
}

/**
 * Escape underscores between word characters to prevent markdown from
 * interpreting them as emphasis markers (e.g. roll_dice.py → italic).
 * Preserves fenced code blocks and inline code.
 */
function escapeIntraWordUnderscores(text: string): string {
    const segments = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
    return segments.map((segment, i) => {
        if (i % 2 === 1) return segment; // code — leave untouched
        return segment.replace(/(?<=\w)_(?=\w)/g, '\\_');
    }).join('');
}

export function Markdown({ children }: MarkdownProps) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                // Code blocks
                pre({ children }) {
                    return (
                        <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 overflow-x-auto my-3 text-sm leading-relaxed">
                            {children}
                        </pre>
                    );
                },
                code({ className, children, ...props }) {
                    const isInline = !className;
                    if (isInline) {
                        return (
                            <code className="bg-gray-100 text-pink-600 px-1.5 py-0.5 rounded text-[13px] font-mono" {...props}>
                                {children}
                            </code>
                        );
                    }
                    return (
                        <code className={`font-mono text-[13px] ${className ?? ''}`} {...props}>
                            {children}
                        </code>
                    );
                },
                // Paragraphs
                p({ children }) {
                    return <p className="mb-2 last:mb-0">{children}</p>;
                },
                // Lists
                ul({ children }) {
                    return <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>;
                },
                ol({ children }) {
                    return <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>;
                },
                li({ children }) {
                    return <li className="leading-relaxed">{children}</li>;
                },
                // Headings
                h1({ children }) {
                    return <h1 className="text-xl font-bold mb-2 mt-3 first:mt-0">{children}</h1>;
                },
                h2({ children }) {
                    return <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h2>;
                },
                h3({ children }) {
                    return <h3 className="text-base font-bold mb-1.5 mt-2 first:mt-0">{children}</h3>;
                },
                // Links
                a({ href, children }) {
                    return (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                            {children}
                        </a>
                    );
                },
                // Blockquotes
                blockquote({ children }) {
                    return (
                        <blockquote className="border-l-4 border-gray-300 pl-4 my-2 text-gray-600 italic">
                            {children}
                        </blockquote>
                    );
                },
                // Tables
                table({ children }) {
                    return (
                        <div className="overflow-x-auto my-2">
                            <table className="min-w-full text-sm border border-gray-200 rounded">
                                {children}
                            </table>
                        </div>
                    );
                },
                th({ children }) {
                    return <th className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-left font-semibold">{children}</th>;
                },
                td({ children }) {
                    return <td className="border-b border-gray-100 px-3 py-2">{children}</td>;
                },
                // Horizontal rule
                hr() {
                    return <hr className="my-3 border-gray-200" />;
                },
                // Strong / em
                strong({ children }) {
                    return <strong className="font-semibold">{children}</strong>;
                },
            }}
        >
            {escapeIntraWordUnderscores(children)}
        </ReactMarkdown>
    );
}
