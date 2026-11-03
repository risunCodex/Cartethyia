import { ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import AuthLayout from "./AuthLayout";

export default function Banned(): ReactNode {
  return (
    <AuthLayout
      title="Access Restricted"
      description="Security policy lockout or untrusted origin address"
      icon={<ShieldAlert size={24} />}
      logoClassName="bg-red bg-none"
    >
      {/* Same panel the error boundary raises: radius, surface, border, body type. */}
      <div className="rounded-panel border border-inner-border bg-surface-2 p-7 text-caption leading-relaxed text-text-secondary">
        <strong className="block text-text-primary mb-2">
          HTTP 403 Forbidden
        </strong>
        This client IP has been temporarily locked out due to repeated invalid credential attempts
        or untrusted proxy headers.
      </div>
    </AuthLayout>
  );
}
