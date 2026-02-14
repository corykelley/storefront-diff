# Notification (Toast) System

**File:** `app/components/Notification.tsx`

A lightweight, global toast notification system that avoids React Context boilerplate.

## Architecture

The system uses a **module-level event bus** pattern:

```
Module scope (Notification.tsx)
├── listeners: Set<(toast) => void>    ← subscriber set
├── notify(message, opts)              ← publisher function
└── <NotificationHost />               ← React component that subscribes
```

Any code in the app can call `notify()` — it doesn't need to be inside a React component or have access to context.

## How It Works

### Publishing (sending a toast)

```typescript
import { notify } from "~/components/Notification";

// Success toast (default)
notify("Run deleted");

// Error toast
notify("Diff failed: Dawn → Custom Theme", { tone: "error" });

// Info toast
notify("Run cancelled and deleted", { tone: "info" });

// Custom dismiss timing
notify("Processing...", { dismissMs: 10000 });
```

**`notify()` internals:**

```typescript
let nextId = 0;
const listeners = new Set<Listener>();

export function notify(message: string, opts?: { tone?: Toast["tone"]; dismissMs?: number }) {
  const toast: Toast = {
    id: String(++nextId),
    message,
    tone: opts?.tone ?? "success",
    dismissMs: opts?.dismissMs ?? 4000,
  };
  for (const fn of listeners) fn(toast);
}
```

Each toast gets a unique incremental ID. All registered listeners are notified immediately.

### Subscribing (rendering toasts)

`<NotificationHost />` is mounted once in the layout (`app/routes/app.tsx`):

```tsx
<AppProvider isEmbeddedApp apiKey={apiKey}>
  <Outlet />
  <NotificationHost />  {/* ← always present */}
</AppProvider>
```

It subscribes to the listener set on mount:

```typescript
export function NotificationHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const handler = (toast: Toast) => setToasts(prev => [...prev, toast]);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  // Auto-dismiss
  // ...

  return (
    <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, ... }}>
      {toasts.map(t => <NotificationCard key={t.id} toast={t} onDismiss={dismiss} />)}
    </div>
  );
}
```

### Auto-Dismiss

Each toast automatically dismisses after `dismissMs` (default 4000ms):

```typescript
useEffect(() => {
  if (!toast.dismissMs) return;
  const timer = setTimeout(() => onDismiss(toast.id), toast.dismissMs);
  return () => clearTimeout(timer);
}, [toast, onDismiss]);
```

Users can also dismiss manually by clicking the "x" button.

## Toast Types

| Tone | Background | Border | Icon | Use For |
|---|---|---|---|---|
| `success` | Light green (#f1f8f5) | Green (#2e7d32) | Checkmark | Successful operations |
| `error` | Light red (#fdf0f0) | Red (#c62828) | X mark | Failures and errors |
| `info` | Light blue (#f0f4ff) | Blue (#1565c0) | Info circle | Neutral information |

## Visual Design

Toasts appear as a stack in the top-right corner:

```
┌─────────────────────────────────┐
│ ✓  Diff complete: Dawn → Draft  │  ← newest on top
│                              ✕  │
└─────────────────────────────────┘
┌─────────────────────────────────┐
│ ✕  Diff failed: Dawn → Custom   │
│                              ✕  │
└─────────────────────────────────┘
```

- Fixed position (doesn't scroll with page)
- Max width: 380px
- Slide-in animation (0.3s ease-out)
- Left border accent in the tone color
- Pointer events only on the toast cards (the container is transparent to clicks)
- z-index: 9999 (above everything else)

## Where Toasts Are Triggered

| Location | Message | Tone |
|---|---|---|
| `app.diff._index.tsx` | "Diff complete: {themes}" | success |
| `app.diff._index.tsx` | "Diff failed: {themes}" | error |
| `app.diff._index.tsx` | "Run deleted" | success |
| `app.diff._index.tsx` | "Run cancelled and deleted" | info |
| `app.diff.$diffRunId.tsx` | "Diff complete!" | success |

## Why Not Use Shopify's Toast?

Shopify App Bridge has its own toast API, but it has limitations:
- Only works inside the Shopify Admin iframe
- Limited customization
- This custom implementation gives full control over styling and behavior
- Works the same in development (outside the iframe) and production (inside it)
