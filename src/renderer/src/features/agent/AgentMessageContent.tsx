import { useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface CodeProps {
  className?: string;
  children?: ReactNode;
}

export function AgentMessageContent({ text }: { text: string }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => (
            <span className="agent-markdown__blocked-media" role="note">
              Markdown 图片已阻止{alt ? `：${alt}` : ""}。请使用带来源的图片产物。
            </span>
          ),
          code: ({ className, children }: CodeProps) => {
            const language = className?.replace("language-", "");
            const source = String(children ?? "").replace(/\n$/, "");
            return language === "mermaid"
              ? <MermaidDiagram source={source} />
              : <code className={className}>{children}</code>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const [markup, setMarkup] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMarkup(null);
    setError(false);
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        fontFamily: "inherit",
      });
      const renderId = `novax-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
      const result = await mermaid.render(renderId, source);
      if (!cancelled) setMarkup(result.svg);
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, [reactId, source]);

  if (error) {
    return <div className="agent-mermaid agent-mermaid--blocked" role="status">图表渲染失败，原始 Mermaid 内容已保留。</div>;
  }
  if (!markup) return <div className="agent-mermaid" role="status">正在渲染图表</div>;
  return <div className="agent-mermaid" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: markup }} />;
}
