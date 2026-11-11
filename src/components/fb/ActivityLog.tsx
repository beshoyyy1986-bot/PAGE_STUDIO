import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { LogEntry } from "./use-log";

const tone: Record<LogEntry["level"], string> = {
  ok: "text-success",
  err: "text-destructive",
  warn: "text-warning",
  info: "text-info",
  muted: "text-muted-foreground",
};

export function ActivityLog({ entries, className }: { entries: LogEntry[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [entries]);
  return (
    <div ref={ref} className={cn("overflow-y-auto bg-surface-sunken px-4 py-2 font-mono text-[11px] leading-5", className)}>
      {entries.length === 0 && <div className="text-muted-foreground">جاهز...</div>}
      {entries.map((e) => (
        <div key={e.id} className={tone[e.level]}>
          <span className="opacity-60">[{e.at}]</span> {e.text}
        </div>
      ))}
    </div>
  );
}
