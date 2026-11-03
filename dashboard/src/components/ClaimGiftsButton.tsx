import { Gift, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useClaimAccountGifts, useRefreshAccountQuota } from "../hooks/quota";
import { getErrorMessage } from "../data/api";
import { toast } from "../lib/toast";
import { Button } from "./ui/button";

/** Shared by provider accounts and quota management; never runs automatically. */
export function ClaimGiftsButton({ accountId, accountName }: {
  readonly accountId: string;
  readonly accountName: string;
}): ReactNode {
  const claim = useClaimAccountGifts(accountId);
  const refresh = useRefreshAccountQuota(accountId);
  const busy = claim.isPending || refresh.isPending;
  return (
    <Button
      size="sm"
      variant="secondary"
      title="Manually claim available ZCode gift plans"
      aria-label={`Claim gifts for ${accountName}`}
      disabled={busy}
      icon={busy ? <Loader2 size={12} className="animate-spin" /> : <Gift size={12} />}
      onClick={() => claim.mutate(undefined, {
        onSuccess: (result) => {
          const detail = [
            result.claimed.length > 0 ? `Claimed: ${result.claimed.join(", ")}` : null,
            result.detail,
          ].filter(Boolean).join(" · ");
          switch (result.state) {
            case "claimed":
              toast.success("Gift plans claimed", detail);
              break;
            case "already_claimed":
              toast.success("Gift plans already claimed", detail);
              break;
            case "nothing":
              toast.success("No gift plans to claim", detail);
              break;
            case "captcha":
              toast.warning("CAPTCHA required — open the ZCode app", detail);
              break;
            case "partial":
              toast.warning("Gift claim only partially completed", detail);
              break;
            case "error":
              toast.error("Gift claim failed", detail);
              break;
          }
          if (result.claimed.length > 0) {
            refresh.mutate(undefined, {
              onSuccess: (refreshed) => {
                if (!refreshed.ok) toast.warning("Gifts claimed; quota refresh failed", refreshed.message);
              },
              onError: (error) => toast.warning("Gifts claimed; quota refresh failed", getErrorMessage(error, "Refresh quota manually")),
            });
          }
        },
        onError: (error) => toast.error("Gift claim failed", getErrorMessage(error, "Unable to claim gift plans")),
      })}
    >
      {busy ? "Claiming…" : "Claim gifts"}
    </Button>
  );
}
