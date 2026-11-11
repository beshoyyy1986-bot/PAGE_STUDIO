import { useCallback, useState } from "react";

export type LogLevel = "ok" | "err" | "warn" | "info" | "muted";
export type LogEntry = { id: number; at: string; level: LogLevel; text: string };

let seq = 0;
export function useLog() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const log = useCallback((text: string, level: LogLevel = "muted") => {
    const at = new Date().toLocaleTimeString("en-GB", { hour12: false });
    setEntries((prev) => [...prev.slice(-299), { id: ++seq, at, level, text }]);
  }, []);
  return { entries, log, clear: () => setEntries([]) };
}
export type Logger = ReturnType<typeof useLog>["log"];
