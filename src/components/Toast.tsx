/** Toast system — context + hook + container.
 *
 * Usage anywhere under <ToastProvider>:
 *   const toast = useToast();
 *   toast.success("Saved", "Invoice recorded.");
 *   toast.error("Upload failed", err.message);
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ToastKind = "success" | "warn" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  ttlMs: number;
}

interface ToastApi {
  push: (kind: ToastKind, title: string, body?: string, ttlMs?: number) => void;
  success: (title: string, body?: string) => void;
  warn: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
  info: (title: string, body?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

let _nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback<ToastApi["push"]>((kind, title, body, ttlMs = 4500) => {
    const id = _nextId++;
    setToasts((prev) => [...prev, { id, kind, title, body, ttlMs }]);
    if (ttlMs > 0) {
      setTimeout(() => dismiss(id), ttlMs);
    }
  }, [dismiss]);

  const api: ToastApi = {
    push,
    success: (t, b) => push("success", t, b),
    warn: (t, b) => push("warn", t, b, 6500),
    error: (t, b) => push("error", t, b, 0),   // errors stick until dismissed
    info: (t, b) => push("info", t, b),
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div className="toast-head">
              <span>{t.title}</span>
              <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
            </div>
            {t.body && <div style={{ color: "var(--fg)", opacity: 0.85 }}>{t.body}</div>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

/** Hook: show one error toast per failed Promise. */
export function useErrorToast() {
  const toast = useToast();
  return useCallback((e: unknown, title = "Error") => {
    const msg = e instanceof Error ? e.message : String(e);
    toast.error(title, msg);
  }, [toast]);
}

/** Keyboard shortcut: Esc to dismiss top-most toast. */
export function useGlobalEsc(handler: () => void) {
  useEffect(() => {
    function on(e: KeyboardEvent) { if (e.key === "Escape") handler(); }
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [handler]);
}
