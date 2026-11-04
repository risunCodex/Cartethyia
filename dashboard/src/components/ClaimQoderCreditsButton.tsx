import { Coins, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useClaimQoderCredits } from "../hooks/quota";
import { getErrorMessage } from "../data/api";
import { toast } from "../lib/toast";
import { Button } from "./ui/button";

/** Manual Qoder daily-credits claim (CREDITS campaign, UMID-gated). */
export function ClaimQoderCreditsButton({ accountId, accountName }: {
  readonly accountId: string;
  readonly accountName: string;
}): ReactNode {
  const claim = useClaimQoderCredits(accountId);
  const busy = claim.isPending;
  return (
    <Button
      size="sm"
      variant="secondary"
      title="Manually claim the Qoder daily CREDITS campaign"
      aria-label={`Claim credits for ${accountName}`}
      disabled={busy}
      icon={busy ? <Loader2 size={12} className="animate-spin" /> : <Coins size={12} />}
      onClick={() => claim.mutate(undefined, {
        onSuccess: (result) => {
          switch (result.state) {
            case "claimed":
              toast.success("Qoder credits claimed", `+${result.amount} credits granted`);
              break;
            case "already_claimed":
              toast.success("Qoder credits already claimed", result.detail ?? undefined);
              break;
            case "nothing":
              toast.success("No CREDITS campaign", "No claimable CREDITS campaign is visible for this account right now.");
              break;
            case "error":
              toast.error("Qoder credit claim failed", result.detail ?? "Claim failed");
              break;
          }
        },
        onError: (error) => toast.error("Qoder credit claim failed", getErrorMessage(error, "Unable to claim credits")),
      })}
    >
      {busy ? "Claiming…" : "Claim credits"}
    </Button>
  );
}
