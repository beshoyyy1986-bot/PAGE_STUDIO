import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({ title, children, className, action }: { title?: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={cn("rounded-xl border border-border bg-card p-4", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone = "default" }: { label: string; value: number | string; tone?: "default" | "success" | "danger" | "warning" | "info" }) {
  const color = {
    default: "text-foreground",
    success: "text-success",
    danger: "text-destructive",
    warning: "text-warning",
    info: "text-info",
  }[tone];
  return (
    <div className="min-w-[78px] rounded-lg border border-border bg-secondary px-3 py-1.5 text-center">
      <div className={cn("text-lg font-bold tabular-nums leading-tight", color)}>{typeof value === "number" ? value.toLocaleString("ar-EG") : value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}
