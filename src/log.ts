type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * An error as a line worth reading. `fetch` reports every network failure as "TypeError: fetch
 * failed" and puts the reason — refused, timed out, DNS — in `cause`, so an unwrapped message
 * cannot distinguish a dead explorer from a container that cannot resolve names at all.
 */
export function reason(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    parts.push(code && !current.message.includes(code) ? `${current.message} (${code})` : current.message);
    current = current.cause;
  }
  if (parts.length === 0) return String(error);
  return parts.join(": ");
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
