import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────

interface Toast {
  id: string;
  message: string;
  tone: "success" | "error" | "info";
  dismissMs?: number;
}

interface NotificationContextValue {
  show: (message: string, opts?: { tone?: Toast["tone"]; dismissMs?: number }) => void;
}

// ── Singleton event bus (avoids React context boilerplate) ───────────

type Listener = (toast: Toast) => void;

const listeners = new Set<Listener>();
let nextId = 0;

/**
 * Call from anywhere in the app to show a top-right notification.
 *
 * ```ts
 * import { notify } from "~/components/Notification";
 * notify("Diff complete!");
 * notify("Something broke", { tone: "error" });
 * ```
 */
export function notify(
  message: string,
  opts?: { tone?: Toast["tone"]; dismissMs?: number },
) {
  const toast: Toast = {
    id: String(++nextId),
    message,
    tone: opts?.tone ?? "success",
    dismissMs: opts?.dismissMs ?? 4000,
  };
  for (const fn of listeners) fn(toast);
}

// ── React component – render once near the root ─────────────────────

export function NotificationHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const handler: Listener = (toast) =>
      setToasts((prev) => [...prev, toast]);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        pointerEvents: "none",
        maxWidth: 380,
      }}
    >
      {toasts.map((t) => (
        <NotificationCard key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}

// ── Individual card ─────────────────────────────────────────────────

const TONE_STYLES: Record<Toast["tone"], { bg: string; border: string; icon: string }> = {
  success: { bg: "#f1f8f5", border: "#2e7d32", icon: "\u2714" },
  error:   { bg: "#fdf0f0", border: "#c62828", icon: "\u2718" },
  info:    { bg: "#f0f4ff", border: "#1565c0", icon: "\u2139" },
};

function NotificationCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (toast.dismissMs && toast.dismissMs > 0) {
      timerRef.current = setTimeout(() => onDismiss(toast.id), toast.dismissMs);
    }
    return () => clearTimeout(timerRef.current);
  }, [toast, onDismiss]);

  const style = TONE_STYLES[toast.tone];

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        pointerEvents: "auto",
        background: style.bg,
        borderLeft: `4px solid ${style.border}`,
        borderRadius: 8,
        boxShadow: "0 4px 24px rgba(0,0,0,0.12)",
        padding: "14px 18px",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        animation: "notif-slide-in 0.3s ease-out",
      }}
    >
      <span
        style={{
          fontSize: 18,
          lineHeight: "22px",
          color: style.border,
          flexShrink: 0,
        }}
      >
        {style.icon}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 14,
          lineHeight: "20px",
          color: "#1a1a1a",
        }}
      >
        {toast.message}
      </span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
          color: "#888",
          padding: 0,
          flexShrink: 0,
        }}
      >
        ✕
      </button>

      {/* slide-in keyframes (injected once) */}
      <style>{`
        @keyframes notif-slide-in {
          from { opacity: 0; transform: translateX(40px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
