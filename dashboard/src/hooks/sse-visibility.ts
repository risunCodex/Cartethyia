import { useEffect, useRef, useState } from "react";

/**
 * Gates an SSE subscription on tab visibility.
 *
 * Browser EventSource connections stay open while the tab is hidden/backgrounded
 * — and each open stream keeps the gateway's scheduled work alive (notifications
 * memory sampling, in-flight polling, share-stats recompute). For a console that
 * has many tabs or a user who just switches away, that is CPU for nothing: the
 * UI is not visible, so the live numbers are not being read.
 *
 * This helper closes the underlying `EventSource` when `document.hidden`, and
 * reopens it when the tab becomes visible again. It returns `false` while
 * hidden so the caller can skip connected work (e.g. the preflight GET) and
 * just await the next visibility flip.
 *
 * The caller must still own the full stream lifecycle (auth preflight, reconnect
 * on error). This only adds the hidden/visible gate on top.
 */
export function useSseWhenVisible(): boolean {
  const [visible, setVisible] = useState(true);
  const hiddenRef = useRef(document.hidden);

  useEffect(() => {
    const sync = (): void => {
      const next = !document.hidden;
      // Only flip state when the value actually changes, so a visibility event
      // that fires without a change does not tear down and rebuild the stream.
      if (hiddenRef.current === next) return;
      hiddenRef.current = next;
      setVisible(next);
    };
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  return visible;
}
