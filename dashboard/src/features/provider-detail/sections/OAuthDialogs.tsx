import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../components/ui/button";
import { Dialog } from "../../../components/ui/dialog";
import { Inline } from "../../../components/ui/inline";
import { Stack } from "../../../components/ui/stack";
import {
  useCompleteOAuthBrowserLogin,
  usePollOAuthDevice,
  useProviderAccounts,
  useStartOAuthDevice,
} from "../../../hooks/providers";
import { queryKeys } from "../../../data/query-keys";
import { toast } from "../../../lib/toast";
import { useTrackedTimeout } from "../../../hooks/use-timeout";

/**
 * Extracts the authorization code from whatever the operator pasted.
 *
 * Accepts a full redirect URL, a bare query string, or the raw code. A pasted
 * URL that carries no `code` is **not** treated as a code: returning the whole
 * URL made the server send it to the token endpoint, which answered `Invalid or
 * expired code` — an error that names the code but is really a failed parse, so
 * the operator retries the same broken paste. A URL with `error` is reported
 * with the provider's own description instead, and a URL with neither is
 * rejected as an unrecognized redirect — unless it carries a provider payload
 * in place of a `code`, which is forwarded whole.
 */
export function extractOAuthCode(raw: string): { code: string } | { error: string } {
  const trimmed = raw.trim();
  const paramsOf = (value: string): URLSearchParams | undefined => {
    try {
      return new URL(value).searchParams;
    } catch {
      return undefined;
    }
  };
  const params =
    paramsOf(trimmed) ??
    new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
  const code = params.get("code");
  if (code) return { code };
  const providerError = params.get("error_description") ?? params.get("error");
  if (providerError) return { error: `The provider refused the login: ${providerError}` };
  /**
   * Not every provider redirects with `code`. Trae's page sends its payload
   * directly — `authCodeInfo` for the PKCE flow, `refreshToken` for the other —
   * and the server's parser reads the whole query. Passing it through is what
   * lets that login finish; the server rejects anything it cannot redeem, with
   * a message specific to the provider.
   */
  if (params.has("authCodeInfo") || params.has("refreshToken") || params.has("refresh_token")) {
    return { code: params.toString() };
  }
  // A query string or a bare code both parse to no `code` param. Only a value
  // that is recognizably a URL is refused; anything else is handed on as the
  // code the operator pasted.
  if (paramsOf(trimmed) !== undefined || trimmed.startsWith("?")) {
    return { error: "That redirect URL carries no authorization code — copy the full URL from the address bar." };
  }
  return { code: trimmed };
}

export function OAuthBrowserDialog({
  providerId,
  authorizeUrl,
  state,
  popup,
  loopback,
  onClose,
}: {
  readonly providerId: string;
  readonly authorizeUrl: string;
  readonly state: string;
  readonly popup: Window | null;
  readonly loopback: boolean;
  readonly onClose: (completed: boolean) => void;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const [callbackValue, setCallbackValue] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const complete = useCompleteOAuthBrowserLogin();
  const scheduleCopyReset = useTrackedTimeout();
  const queryClient = useQueryClient();
  // The popup navigates through the hosted `/oauth/callback` route, so the
  // server completes the exchange and persists the account without the
  // dashboard ever relaying the code back. Poll the account list to detect
  // that completion and auto-close; the single-use manual-paste state
  // otherwise reads as "unknown or expired" after the popup already consumed
  // it. The manual field below stays available for redirects that landed on
  // an address the browser could not deliver back to the server.
  const accountsQuery = useProviderAccounts(providerId);
  const baselineAccountIdsRef = useRef<ReadonlySet<string> | null>(null);
  const completionDetectedRef = useRef(false);
  // The baseline must come from a *fresh* account read, not a cached snapshot.
  // A snapshot left over from a previous login can list the account that login
  // added, and if it becomes the baseline here, this login "completes"
  // instantly when that earlier account first shows up in the poll — the
  // dialog closes claiming success for a login that never happened.
  const [baselinePending, setBaselinePending] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.providers.accounts(providerId),
      });
    }, 1500);
    return () => clearInterval(interval);
  }, [queryClient, providerId]);

  useEffect(() => {
    let cancelled = false;
    void queryClient
      .invalidateQueries({ queryKey: queryKeys.providers.accounts(providerId) })
      .finally(() => {
        if (!cancelled) setBaselinePending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient, providerId]);

  useEffect(() => {
    if (baselinePending) return;
    const ids = accountsQuery.data?.map((account) => account.id) ?? null;
    if (ids === null) return;
    if (baselineAccountIdsRef.current === null) {
      baselineAccountIdsRef.current = new Set(ids);
      return;
    }
    if (completionDetectedRef.current) return;
    const added = ids.find((id) => !baselineAccountIdsRef.current!.has(id));
    if (added === undefined) return;
    completionDetectedRef.current = true;
    popup?.close();
    toast.success("Account connected", "OAuth login completed successfully");
    onClose(true);
  }, [accountsQuery.data, baselinePending, popup, onClose]);

  const cancel = () => {
    popup?.close();
    onClose(false);
  };

  // Fast path for "I already approved in the popup": refresh the account
  // list now instead of waiting for the next 1.5 s tick. The completion
  // effect above closes the dialog itself when the new account arrives.
  const [checking, setChecking] = useState(false);
  const handleComplete = () => {
    setChecking(true);
    void queryClient
      .invalidateQueries({ queryKey: queryKeys.providers.accounts(providerId) })
      .finally(() => setChecking(false));
  };
  const handlePasteCallback = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast.error("Clipboard is empty");
        return;
      }
      setCallbackValue(text);
      toast.success("Pasted redirect URL");
    } catch {
      toast.error("Clipboard unavailable on this origin");
    }
  };

  // A dropped file can hold the redirect URL (or raw code) — read it straight
  // into the same field the paste path fills. The drop zone is the textarea's
  // bounding row, so a sloppy drop still lands on it.
  const handleDropCallbackFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result.trim() : "";
      if (!text) {
        toast.error("Empty file", `"${file.name}" contained no URL to connect with.`);
        return;
      }
      const parsed = extractOAuthCode(text);
      if ("error" in parsed) {
        // Invalid material does not close the modal — it just empties the
        // field so the operator can try again with a clean paste.
        setCallbackValue("");
        toast.error("Invalid OAuth paste", parsed.error);
        return;
      }
      setCallbackValue(text);
      toast.success("Loaded redirect URL", `Read from ${file.name}`);
    };
    reader.onerror = () => toast.error("Could not read file", `Failed to read "${file.name}".`);
    reader.readAsText(file);
  };

  const handleConnect = () => {
    const parsed = extractOAuthCode(callbackValue);
    if ("error" in parsed) {
      // Invalid paste does not close the modal — it resets the field so the
      // operator can immediately paste the correct URL without reopening.
      setCallbackValue("");
      toast.error("OAuth callback failed", parsed.error);
      return;
    }
    complete.mutate(
      { providerId, code: parsed.code, state },
      {
        onSuccess: () => {
          popup?.close();
          toast.success("Account connected", "OAuth login completed successfully");
          onClose(true);
        },
        onError: (err) =>
          toast.error(
            "OAuth callback failed",
            (err as { message?: string }).message ?? "Invalid or expired authorization code",
          ),
      },
    );
  };

  return (
    <Dialog
      open={true}
      onClose={cancel}
      title="Connect via OAuth"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={cancel} disabled={complete.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleComplete}
            disabled={complete.isPending || checking}
            title="You already approved in the popup — check now instead of waiting"
          >
            {checking ? "Checking…" : "Complete"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={complete.isPending || callbackValue.trim().length === 0}
            onClick={handleConnect}
          >
            {complete.isPending ? "Connecting…" : "Connect"}
          </Button>
        </>
      }
    >
      <Stack gap="14px">
        {loopback ? (
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-card border border-inner-border bg-surface-2">
            <Loader2 size={16}
             className="animate-spin text-accent shrink-0"/>
            <span className="text-body font-semibold">Waiting for popup authorization…</span>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-card border border-inner-border bg-surface-2">
            <ExternalLink size={16} className="text-accent shrink-0" />
            <span className="text-body font-semibold">
              This gateway runs on a server — open the URL in your browser, then paste the redirect URL back.
            </span>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="text-body font-semibold text-text-primary">Step 1: Open this URL in your browser</div>
          <Inline gap="8px">
            <a
              className="min-w-0 flex-1 font-mono text-badge text-accent overflow-hidden text-ellipsis whitespace-nowrap px-2.5 py-2 rounded-control bg-input-bg border border-inner-border"
              href={authorizeUrl}
              target="_blank"
              rel="noreferrer"
              title={authorizeUrl}
            >
              {authorizeUrl}
            </a>
            <Button
              variant="secondary"
              size="sm"
              icon={copied ? <Check size={12} /> : <Copy size={12} />}
              onClick={() => {
                void navigator.clipboard?.writeText(authorizeUrl);
                setCopied(true);
                scheduleCopyReset(() => setCopied(false), 1500);
              }}
              className="shrink-0"
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </Inline>
          <p className="text-badge leading-snug text-text-tertiary">
            {loopback
              ? "A popup should open automatically. If it was blocked, open the URL above manually."
              : "Open the URL on the machine whose browser can reach the provider sign-in. The gateway listens for the callback over its public origin, so the code lands back here automatically."}
          </p>
        </div>

        <div className="flex items-center gap-2.5 text-micro font-bold uppercase tracking-label text-text-tertiary"><span aria-hidden="true" className="flex-1 h-px bg-inner-border" /><span>Or complete manually</span><span aria-hidden="true" className="flex-1 h-px bg-inner-border" /></div>

        <div className="flex flex-col gap-2">
          <div className="text-body font-semibold text-text-primary">Step 2: Paste the redirect URL here</div>
          <p className="text-badge leading-snug text-text-tertiary">
            If the redirect lands on an unreachable address, copy that page&apos;s full URL from
            your browser and paste it below — this works from any machine, not just localhost.
          </p>
          <Inline gap="8px" align="flex-start">
            <div
              className={`flex-1 min-w-0 rounded-control border-2 border-dashed transition-colors ${
                dragActive ? "border-accent bg-accent-soft" : ""
              }`}
              data-drag-active={dragActive ? "true" : undefined}
              onDragOver={(event) => {
                event.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActive(false);
                const file = event.dataTransfer.files[0];
                if (file) {
                  handleDropCallbackFile(file);
                  return;
                }
                // A text drop (selecting the redirect URL in the browser and
                // dragging it here) carries no file — read it from the data
                // transfer and feed it through the same parser the paste path
                // uses. Validity is still decided at Connect time, exactly like
                // a paste.
                const text = event.dataTransfer.getData("text/plain");
                if (!text || !text.trim()) return;
                const trimmed = text.trim();
                const parsed = extractOAuthCode(trimmed);
                if ("error" in parsed) {
                  setCallbackValue("");
                  toast.error("Invalid OAuth paste", parsed.error);
                  return;
                }
                setCallbackValue(trimmed);
                toast.success("Loaded redirect URL", "Dropped URL text");
              }}
            >
              <textarea
                value={callbackValue}
                onChange={(event) => setCallbackValue(event.target.value)}
                placeholder="http://127.0.0.1:59653/callback?code=…&state=…  (or just the code)"
                rows={2}
                spellCheck={false}
                className="w-full min-h-16 resize-y rounded-control border border-inner-border bg-input-bg px-2.5 py-2 font-mono text-badge text-text-primary box-border focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handlePasteCallback()}
              className="shrink-0"
            >
              Paste
            </Button>
          </Inline>
          <p className="text-badge leading-snug text-text-tertiary">
            Or drag a file — or select the redirect URL and drag it here — a saved
            redirect URL or raw code is read straight into the field.
          </p>
        </div>
      </Stack>
    </Dialog>
  );
}

function verificationHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export function DeviceCodeDialog({
  providerId,
  parameters,
  onClose,
}: {
  readonly providerId: string;
  /** Values the provider declared for its device flow, chosen before it started. */
  readonly parameters?: Record<string, string>;
  readonly onClose: () => void;
}): ReactNode {
  const startDevice = useStartOAuthDevice();
  const pollDevice = usePollOAuthDevice();
  const [session, setSession] = useState<{
    verificationUri: string;
    userCode: string;
    deviceAuthId: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const scheduleCopyReset = useTrackedTimeout();
  useEffect(() => {
    // StrictMode mounts, unmounts, and remounts this dialog in development, and
    // this effect starts a device flow on every mount. Both requests reach the
    // provider. Letting whichever resolves last win `setSession` would put the
    // code on screen and the code being polled in a flow the operator never
    // approved — the provider then answers "still pending" forever. The first
    // start is the one shown and polled; a later one is dropped.
    let cancelled = false;
    startDevice.mutate(
      {
        providerId,
        ...(parameters === undefined || Object.keys(parameters).length === 0 ? {} : { parameters }),
      },
      {
        onSuccess: (result) => {
          if (cancelled) return;
          setSession(result);
        },
        onError: (err) => {
          if (cancelled) return;
          toast.error(
            "Failed to start device login",
            (err as { message?: string }).message ?? "Unable to start device authorization",
          );
          onClose();
        },
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opens the verification page in a popup when the session arrives (popup
  // blockers allow it here because this effect still runs in the click
  // chain's task — the session resolves from the start-device POST the click
  // fired). Falls back to a manual Open/Copy when the popup is blocked.
  const verificationPopupRef = useRef<Window | null>(null);
  const [verificationPopupBlocked, setVerificationPopupBlocked] = useState(false);
  useEffect(() => {
    if (!session) return;
    const popup = window.open(session.verificationUri, "cartethyia-device", "popup,width=720,height=820");
    if (popup) {
      verificationPopupRef.current = popup;
    } else {
      setVerificationPopupBlocked(true);
    }
    return () => {
      const open = verificationPopupRef.current;
      verificationPopupRef.current = null;
      if (open && !open.closed) open.close();
    };
  }, [session]);

  // No manual poll. GitHub's device flow rejects a poll that arrives inside
  // its minimum interval with `slow_down`, and then keeps rejecting that
  // device code. A button that fires a poll beside the scheduled one is
  // exactly that, so the only poll is the one the loop schedules.

  useEffect(() => {
    if (!session) return;
    const startedAt = Date.now();
    const expiresInMs = Math.max(1, session.expiresInSeconds) * 1000;
    let pollInFlight = false;
    let intervalMs = Math.max(1, session.intervalSeconds) * 1000;
    // A poll request outlives this effect: closing the dialog, or the session
    // changing, does not cancel the POST already in flight. Its result belongs
    // to the session that sent it. Applying it anyway showed "connected" for a
    // login whose row was never written.
    let stale = false;
    // One timer, ever. Rescheduling must not add a fresh interval beside the one
    // already running, or two polls leave per cadence. GitHub's device flow
    // answers `slow_down` the moment a poll arrives inside its minimum, and
    // keeps answering it — the code the operator approves then never yields a
    // token. The next poll is always scheduled from the answer, not piled on.
    let timer = 0;
    const clearTimer = () => window.clearTimeout(timer);
    const schedule = (delayMs: number) => {
      clearTimer();
      timer = window.setTimeout(poll, delayMs);
    };
    const poll = () => {
      if (stale) return;
      if (Date.now() - startedAt > expiresInMs) {
        clearTimer();
        toast.error("Device login expired", "Please try again.");
        onClose();
        return;
      }
      if (pollInFlight) return;
      pollInFlight = true;
      pollDevice.mutate(
        { providerId, deviceAuthId: session.deviceAuthId },
        {
          onSuccess: (result) => {
            pollInFlight = false;
            if (stale) return;
            if (result.status === "complete") {
              clearTimer();
              const open = verificationPopupRef.current;
              if (open && !open.closed) open.close();
              toast.success("OAuth account connected", "Device authorization complete");
              onClose();
            } else if (result.status === "failed") {
              clearTimer();
              toast.error("Device login failed", result.reason);
              onClose();
            } else if (result.status === "slow_down") {
              // GitHub enforces the widened cadence: polling any sooner draws
              // another slow_down, and the flow never completes. A second is
              // added because an answer that arrives on the boundary counts as
              // early.
              const nextMs =
                result.retryAfterSeconds !== undefined
                  ? Math.max(1, result.retryAfterSeconds) * 1000
                  : intervalMs + 5000;
              intervalMs = nextMs + 1000;
              schedule(intervalMs);
            } else {
              if (result.status === "pending" && result.retryAfterSeconds !== undefined) {
                intervalMs = Math.max(1, result.retryAfterSeconds) * 1000 + 1000;
              }
              schedule(intervalMs);
            }
          },
          onError: (err) => {
            pollInFlight = false;
            if (stale) return;
            clearTimer();
            const message = (err as { message?: string }).message;
            toast.error("Device login failed", message ?? "The device flow ended without a result.");
            onClose();
          },
        },
      );
    };
    // The first poll fires only after one full interval, never immediately:
    // the user needs those seconds to approve on the provider page, and a
    // poll that lands before any approval is possible only spends a request
    // toward the provider's rate limit.
    schedule(intervalMs + 1000);
    return () => {
      stale = true;
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return (
    <Dialog
      open={true}
      onClose={onClose}
      title="Login with OAuth (device code)"
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {null}
        </>
      }
    >
      <Stack gap="14px">
        {!session ? (
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-card border border-inner-border bg-surface-2">
            <Loader2 size={16}
             className="animate-spin text-accent shrink-0"/>
            <span className="text-body font-semibold">Starting device authorization…</span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-card border border-inner-border bg-surface-2">
              <Loader2 size={16}
               className="animate-spin text-accent shrink-0"/>
              <span className="text-body font-semibold">Waiting for authorization…</span>
            </div>

            {session.userCode ? (
              <div className="flex flex-col gap-2">
                <div className="text-body font-semibold text-text-primary">Step 1: Enter this code</div>
                <div className="rounded-card border border-inner-border bg-surface-2 p-3.5 flex flex-col gap-1.5 items-center text-center">
                  <div className="text-micro font-bold uppercase tracking-label text-text-tertiary">Device code</div>
                  <div className="font-mono text-display font-bold tracking-code text-text-primary">{session.userCode}</div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={copiedCode ? <Check size={12} /> : <Copy size={12} />}
                    onClick={() => {
                      void navigator.clipboard?.writeText(session.userCode);
                      setCopiedCode(true);
                      scheduleCopyReset(() => setCopiedCode(false), 1500);
                    }}
                  >
                    {copiedCode ? "Copied" : "Copy code"}
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <div className="text-body font-semibold text-text-primary">
                {session.userCode
                  ? "Step 2: Open the verification page"
                  : "Open the verification page to authorize"}
              </div>
              <Inline gap="8px">
                <a
                  className="min-w-0 flex-1 font-mono text-badge text-accent overflow-hidden text-ellipsis whitespace-nowrap px-2.5 py-2 rounded-control bg-input-bg border border-inner-border"
                  href={session.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  title={session.verificationUri}
                >
                  {verificationHost(session.verificationUri)}
                </a>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<ExternalLink size={12} />}
                  onClick={() => window.open(session.verificationUri, "_blank", "noopener")}
                  className="shrink-0"
                >
                  Open
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={copied ? <Check size={12} /> : <Copy size={12} />}
                  onClick={() => {
                    void navigator.clipboard?.writeText(session.verificationUri);
                    setCopied(true);
                    scheduleCopyReset(() => setCopied(false), 1500);
                  }}
                  className="shrink-0"
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </Inline>
              <p className="text-badge leading-snug text-text-tertiary">
                {verificationPopupBlocked
                  ? "The popup was blocked — open the page with Open above, finish signing in there, then press Check now."
                  : "The page opened in a popup. Finish signing in there — this dialog closes automatically once the account connects, or press Check now."}
              </p>
            </div>
          </>
        )}
      </Stack>
    </Dialog>
  );
}
