"use client";

import { useAuiState } from "@assistant-ui/react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import { renderMermaidSVG } from "beautiful-mermaid";
import { type FC, memo, useMemo } from "react";
import { cn } from "@/lib/utils";

export type MermaidDiagramProps = SyntaxHighlighterProps & {
  className?: string;
};

const MermaidDiagramImpl: FC<MermaidDiagramProps> = ({
  code,
  className,
}) => {
  const isComplete = useAuiState((state) => state.optional.part?.status.type !== "running");
  const result = useMemo(() => {
    if (!isComplete) return undefined;
    try {
      return {
        svg: renderMermaidSVG(code, {
          bg: "var(--background)",
          fg: "var(--foreground)",
          muted: "var(--muted-foreground)",
          border: "var(--border)",
          accent: "var(--foreground)",
          transparent: true,
        }),
      };
    } catch (cause) {
      return { error: cause instanceof Error ? cause : new Error(String(cause)) };
    }
  }, [code, isComplete]);

  if (!result) {
    return (
      <div
        role="status"
        aria-label="図を描画しています"
        className={cn("aui-mermaid-skeleton bg-muted flex h-32 animate-pulse items-center justify-center gap-3 rounded-b-lg p-4", className)}
      >
        <div className="bg-muted-foreground/20 h-8 w-20 rounded-md" />
        <div className="bg-muted-foreground/20 h-px w-10" />
        <div className="bg-muted-foreground/20 h-8 w-20 rounded-md" />
      </div>
    );
  }

  if ("error" in result) {
    return (
      <div className={cn("aui-mermaid-fallback bg-muted/75 rounded-b-lg", className)}>
        <pre className="overflow-x-auto p-4 text-sm">{code.trim()}</pre>
        <p role="alert" className="text-muted-foreground border-border border-t px-4 py-1.5 text-xs">図を描画できませんでした。</p>
      </div>
    );
  }

  return (
    <div
      data-slot="mermaid-diagram"
      className={cn("aui-mermaid-diagram bg-muted overflow-x-auto rounded-b-lg p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full", className)}
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
};

export const MermaidDiagram = memo(MermaidDiagramImpl);
MermaidDiagram.displayName = "MermaidDiagram";
