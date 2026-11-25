import { Eye, EyeOff, Loader2, MonitorSmartphone } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/button";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Banner } from "../../components/patterns/banner";
import { toast } from "../../lib/toast";
import { getErrorMessage } from "../../data/api";
import { useSetTrayVisibility, useTrayStatus } from "../../hooks/tray";

/**
 * The tray icon's visibility, from the console.
 *
 * The CLI has had this since tray hide/show shipped (`carte tray hide|show`);
 * this is the same control for the operator who is already in the dashboard.
 * The panel says what the icon state is, offers the one action that changes it,
 * and names the other way back — hiding an icon is only safe if restoring it is
 * obvious, and the tray menu is gone once it is hidden.
 *
 * Both buttons can be present but only one enabled at a time: the disabled one
 * says the action is real and currently pointless, which reads better than a
 * button that vanishes and reappears.
 */
export function TrayPanel(): ReactNode {
  const status = useTrayStatus();
  const mutation = useSetTrayVisibility();

  if (status.isPending) return <LoadingState label="Checking for a running tray…" compact />;
  if (status.isError || !status.data) {
    return (
      <ErrorState
        message={getErrorMessage(status.error, "Failed to read the tray status")}
        onRetry={() => void status.refetch()}
      />
    );
  }

  const { running, hidden } = status.data;

  const change = (action: "hide" | "show"): void => {
    mutation.mutate(action, {
      onSuccess: (next) => {
        toast.success(next.hidden ? "Icon hidden" : "Icon shown");
      },
      onError: (error) => toast.error(getErrorMessage(error, "Could not change the tray icon")),
    });
  };

  // The route refuses a browser that is not on the gateway's machine. The
  // status read works from anywhere, so explaining that here is what stops the
  // buttons reading as broken.
  const localOnly = mutation.error?.code === "tray_control_local_only";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-caption text-text-primary">
            {running
              ? hidden
                ? "The tray is running, with its icon hidden."
                : "The tray is running, with its icon visible."
              : "No tray is running on this machine."}
          </span>
          <span className="text-caption text-text-tertiary">
            {running ? (
              <>
                Hiding keeps the gateway and the tray running; bring the icon back here or with{" "}
                <code>carte tray show</code>.
              </>
            ) : (
              <>
                Start one with <code>carte tray</code> to control its icon from here.
                {/* The last state outlives the tray, so a start that comes back
                    with no icon is the operator's own earlier choice — said here
                    so it does not read as a broken install. */}
                {status.data.lastHidden === null
                  ? null
                  : ` It will start with the icon ${status.data.lastHidden ? "hidden" : "visible"}, as you left it.`}
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="secondary"
            size="sm"
            icon={mutation.isPending ? <Loader2 className="animate-spin" size={14} /> : <EyeOff size={14} />}
            onClick={() => change("hide")}
            disabled={!running || hidden || mutation.isPending}
          >
            Hide icon
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={mutation.isPending ? <Loader2 className="animate-spin" size={14} /> : <Eye size={14} />}
            onClick={() => change("show")}
            disabled={!running || !hidden || mutation.isPending}
          >
            Show icon
          </Button>
        </div>
      </div>
      {localOnly ? (
        <Banner tone="warning" surface="raised" live="status">
          <span className="inline-flex items-center gap-2">
            <MonitorSmartphone size={14} aria-hidden="true" />
            Tray control only works from the machine running the gateway.
          </span>
        </Banner>
      ) : null}
    </div>
  );
}
