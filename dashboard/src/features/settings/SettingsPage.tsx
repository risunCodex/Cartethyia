import {
  Archive,
  Database,
  Eye,
  Shield,
  Zap,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Select } from "../../components/ui/select";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ErrorState, LoadingState } from "../../components/ui/state";
import { Banner } from "../../components/patterns/banner";
import { BackupPanel } from "../../components/BackupPanel";
import { DataManagementPanel } from "./DataManagementPanel";
import { toast } from "../../lib/toast";
import { useChangePassword } from "../../hooks/auth";
import {
  useRuntimeSettings,
  useUpdateRuntimeSettings,
} from "../../hooks/settings";
import { getErrorMessage } from "../../data/api";
/**
 * The values the operational dropdowns offer.
 *
 * Each is a bounded number the backend clamps anyway, so offering the range as
 * choices says what is actually reachable instead of accepting anything and
 * correcting it out of sight. The lists are deliberately short and land on the
 * round values an operator would type; a deployment default is a separate
 * option, because "unset" is a real state rather than one of the numbers.
 */
const TIMEOUT_CHOICES = [5, 15, 30, 60, 120, 300, 600] as const;
/** How long requests stay in full before being folded into the day summary. */
const WINDOW_CHOICES = [5, 15, 30, 60, 180, 720, 1440] as const;
const ATTACHMENT_CHOICES = [1, 5, 10, 25, 50, 100] as const;

/**
 * The icon for a section, keyed by its id.
 *
 * Kept as a map rather than a prop so a section cannot be added without
 * deciding what it looks like, and so the five cannot drift apart in style.
 *
 * Backup is an archive rather than a second database: the two data sections
 * are one glyph apart otherwise, and the strip is read at a glance.
 */
function SectionIcon({ name }: { readonly name: string }): ReactNode {
  const props = { size: 16 } as const;
  if (name === "privacy") return <Eye {...props} />;
  if (name === "operations") return <Zap {...props} />;
  if (name === "data") return <Archive {...props} />;
  if (name === "data-management") return <Database {...props} />;
  return <Shield {...props} />;
}

/**
 * Options for a bounded-number dropdown, including the operator's own value.
 *
 * A stored value need not be one we offer — it may predate this list, or have
 * been set by another surface. Dropping it would render the trigger empty for
 * a setting that is very much in force, which reads as "unset" and invites the
 * operator to change something that is already right. So the current value is
 * appended when it is not among the choices, and sorted back into place.
 */
export function boundedOptions(
  choices: readonly number[],
  current: number | null,
  suffix: (value: number) => string,
): { value: string; label: string }[] {
  const values =
    current === null || choices.includes(current)
      ? [...choices]
      : [...choices, current].sort((a, b) => a - b);
  return values.map((value) => ({ value: String(value), label: suffix(value) }));
}

/**
 * The sections, in tab order.
 *
 * One entry is the whole description of a section: its id doubles as the URL
 * hash, so a link to #operations from elsewhere in the console lands in the
 * right place without a second table mapping anchors to cards.
 */
const SECTIONS = [
  {
    id: "security",
    title: "Security",
    description: "Change the password used to sign in to this console.",
  },
  {
    id: "privacy",
    title: "Privacy",
    description:
      "What request telemetry stores, and how client addresses are shown.",
  },
  {
    id: "backup",
    title: "Backup",
    description: "Export or restore this tenant's configuration and history.",
  },
  {
    id: "operations",
    title: "Operations",
    description:
      "Routing, admission, request handling, and response shaping for this tenant.",
  },
  {
    id: "data-management",
    title: "Data Management",
    description:
      "See what the gateway keeps on disk, reclaim space, and flush queued writes.",
  },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * A duration in minutes, in the units the operator chose it in.
 *
 * 60 renders "1 hour" and 1440 "1 day" because that is what the dropdown they
 * picked from said. Rendering the same choice as "60 min" makes the two
 * places disagree about what is set.
 */
function formatMinutes(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} min`;
}

/**
 * "Deployment default (75 seconds)" — the number, not just the words.
 *
 * A dropdown that offers "Deployment default" as an opaque choice asks the
 * operator to accept a value they cannot see, and the one place they could
 * look it up is an env var on a server they are not on. The default is sent
 * with the settings rather than copied into this file, so a deployment that
 * changes it still shows the truth.
 */
function defaultLabel(text: string): string {
  return `Deployment default (${text})`;
}

/** Megabytes, whole — a ceiling in bytes is not a number anyone reads. */
function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * One control row: label and help text on the left, the control on the right.
 *
 * Two columns rather than stacked, because a stacked field puts the hint
 * between the label and the control and the eye has to cross it twice. On the
 * right the control edge stays aligned down the card, so scanning for a
 * setting is one straight line and the hint stays under what it explains.
 *
 * `htmlFor` points at the control's id, so clicking a label reaches it. Rows
 * whose control is a button group rather than a single input pass `labelFor`
 * as undefined and stay a plain span — a label pointing at a button is a
 * second activation path, which is how the switch used to fire twice.
 */
function SettingsRow({
  label,
  hint,
  labelFor,
  control,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly labelFor?: string;
  readonly control: ReactNode;
}): ReactNode {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        {labelFor ? (
          <label className="settings-row-label" htmlFor={labelFor}>
            {label}
          </label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        {hint ? <p className="settings-row-hint">{hint}</p> : null}
      </div>
      <div className="settings-row-control">{control}</div>
    </div>
  );
}

/**
 * Divides one section's rows into named groups.
 *
 * Operations carries seven controls across four concerns. Flat, the timeout and
 * the reasoning summary read as neighbours when nothing connects them, and the
 * only cue that they are not is the operator's own memory of the page.
 *
 * Rendered as a `<p>` styled like a label rather than an `<h3>`: it is a
 * divider inside a card that already has an `h2`, and a third heading level
 * would put it in the document outline beside the section titles.
 */
function SettingsGroup({ title }: { readonly title: string }): ReactNode {
  return <p className="settings-group-head">{title}</p>;
}

/**
 * One section, as a card.
 *
 * `id` anchors deep links (#operations) — with every section rendered, the
 * anchor is what keeps a link from elsewhere in the console useful.
 */
function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Card id={id} aria-label={title} className="min-w-0">
      <CardHeader
        title={title}
        subtitle={description}
        icon={<SectionIcon name={id} />}
      />
      <CardBody className="flex flex-col gap-0">{children}</CardBody>
    </Card>
  );
}

function PrivacyPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data;
  if (query.isPending)
    return <LoadingState label="Loading privacy settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(
          query.error,
          "Failed to load runtime settings",
        )}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <>
      <SettingsRow
        label="Telemetry payloads"
        labelFor="privacy-payloads"
        hint="Request metadata is always kept. Bodies stay off until you turn them on, and anything captured is redacted and deleted when the Request detail window in Operations runs out."
        control={
          <Select
            aria-label="Telemetry payloads"
            id="privacy-payloads"
            value={settings.telemetryPayloads}
            onValueChange={(value) =>
              mutation.mutate(
                {
                  telemetryPayloads:
                    value === "full" || value === "metadata" ? value : "none",
                },
                {
                  onSuccess: () => toast.success("Payload capture updated"),
                  onError: (error) =>
                    toast.error(
                      getErrorMessage(error, "Could not update payload capture."),
                    ),
                },
              )
            }
            options={[
              { value: "none", label: "Off — no payload capture" },
              {
                value: "metadata",
                label: "Metadata — method and headers only",
              },
              { value: "full", label: "Full — redacted bodies" },
            ]}
          />
        }
      />
      {/*
       * Capture depth only exists when payloads are "full", so it does not
       * appear otherwise rather than leaving a dead row behind.
       */}
      {settings.telemetryPayloads === "full" ? (
        <>
          <SettingsRow
            label="Capture depth"
            labelFor="privacy-payload-depth"
            hint="Size cap for each captured body."
            control={
              <Select
                aria-label="Capture depth"
                id="privacy-payload-depth"
                value={settings.telemetryPayloadDepth}
                onValueChange={(value) =>
                  mutation.mutate(
                    {
                      telemetryPayloadDepth:
                        value === "moderate" || value === "maximum"
                          ? value
                          : "minimum",
                    },
                    {
                      onSuccess: () => toast.success("Capture depth updated"),
                      onError: (error) =>
                        toast.error(
                          getErrorMessage(
                            error,
                            "Could not update capture depth.",
                          ),
                        ),
                    },
                  )
                }
                options={[
                  { value: "minimum", label: "Minimum — 1 MiB cap" },
                  { value: "moderate", label: "Moderate — 8 MiB cap" },
                  { value: "maximum", label: "Maximum — 16 MiB cap" },
                ]}
          />
          }
          />
          {settings.telemetryPayloadDepth !== "minimum" ? (
            <div className="settings-row-banner">
              <Banner
                tone="warning"
                surface="raised"
                className="text-text-secondary"
              >
                <strong>High CPU and memory while this is on.</strong> Use it to
                debug, then switch back to Metadata or Minimum.
              </Banner>
            </div>
          ) : null}
        </>
      ) : null}
      <SettingsRow
        label="Client IP display"
        labelFor="privacy-ip"
        hint="Raw addresses stay stored and are still written to telemetry. This only changes how they are shown in the console."
        control={
          <Select
            aria-label="Client IP display"
            id="privacy-ip"
            value={settings.privacyMode}
            onValueChange={(value) =>
              mutation.mutate(
                { privacyMode: value === "full" ? "full" : "masked" },
                {
                  onSuccess: () => toast.success("IP display updated"),
                  onError: (error) =>
                    toast.error(
                      getErrorMessage(error, "Could not update IP display."),
                    ),
                },
              )
            }
            options={[
              { value: "masked", label: "Masked — recommended" },
              { value: "full", label: "Show full IP" },
            ]}
          />
        }
      />
    </>
  );
}

/**
 * Operational overrides, exposed as per-tenant runtime settings rather than
 * deployment-only env vars.
 *
 * These are the knobs an operator reaches for while an install is running — a
 * provider misbehaving, a timeout that no longer fits — so they are editable
 * per tenant and take effect without a restart. Each one says plainly what it
 * costs, because the defaults exist for a reason.
 */
/**
 * Operational overrides, exposed as per-tenant runtime settings rather than
 * deployment-only env vars.
 *
 * These are the knobs an operator reaches for while an install is running — a
 * provider misbehaving, a timeout that no longer fits — so they are editable
 * per tenant and take effect without a restart. Each one says plainly what it
 * costs, because the defaults exist for a reason.
 */

/**
 * Routing: whether a cooled-down account may still be dialed.
 *
 * Its own section because the warning under it is long enough to bury
 * anything that followed it in a shared panel, and because this is the one
 * operational switch that can make every request fail.
 */
/**
 * Operational overrides, exposed as per-tenant runtime settings rather than
 * deployment-only env vars.
 *
 * These are the knobs an operator reaches for while an install is running — a
 * provider misbehaving, a timeout that no longer fits — so they are editable
 * per tenant and take effect without a restart. Each one says plainly what it
 * costs, because the defaults exist for a reason.
 *
 * Seven controls in one card, under four group headings. Splitting them into
 * four sections was tried and undone: it turned one populated card into four
 * sparse ones, each with its own header, border, and padding, and the page
 * became mostly chrome. The headings here carry the same grouping at a size
 * that does not compete with the section title.
 */
function OperationalPanel(): ReactNode {
  const query = useRuntimeSettings();
  const mutation = useUpdateRuntimeSettings();
  const settings = query.data;
  if (query.isPending)
    return <LoadingState label="Loading operational settings…" />;
  if (query.isError || !settings) {
    return (
      <ErrorState
        message={getErrorMessage(
          query.error,
          "Failed to load runtime settings",
        )}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const save = (
    patch: Parameters<typeof mutation.mutate>[0],
    message: string,
  ): void => {
    mutation.mutate(patch, {
      onSuccess: () => toast.success(message),
      onError: (error) =>
        toast.error(getErrorMessage(error, "Could not update settings.")),
    });
  };

  return (
    <>
      <SettingsGroup title="Routing" />
      <SettingsRow
        label="Ignore cooldowns"
        labelFor="ignore-cooldowns"
        hint="Route to accounts that are cooling down, including ones already parked. Off by default: a cooling account stays out of the rotation until it resets. On dials it anyway, which is what the warning below is about."
        control={
          <Select
            aria-label="Ignore cooldowns"
            id="ignore-cooldowns"
            value={settings.forceDisableCooldown ? "on" : "off"}
            onValueChange={(value) => {
              const next = value === "on";
              save(
                { forceDisableCooldown: next },
                next
                  ? "Cooldowns are ignored."
                  : "Cooldowns are enforced again.",
              );
            }}
            options={[
              { value: "off", label: "Off — default" },
              { value: "on", label: "On" },
            ]}
          />
        }
      />
      {settings.forceDisableCooldown ? (
        <div className="settings-row-banner">
          <Banner tone="warning" surface="raised" live="status">
            <strong>This may cause admission failure.</strong> A cooled-down
            account was parked because the upstream refused it, so dialing it
            anyway reproduces that refusal on every attempt — and if every
            candidate is cooling, the request fails instead of waiting for a
            reset. The cooldown is still recorded and still recovered by the
            sweep, so turning this back off needs no cleanup. Per-model
            cooldowns are still enforced.
          </Banner>
        </div>
      ) : null}

      {/*
       * Tenant-wide concurrency. The tolerance above a key's own limit used to
       * be editable per key in the Edit API Key modal, which silently won over
       * this value — so raising it here appeared to do nothing for that key.
       * Both now live in this one place.
       */}
      <SettingsGroup title="Admission" />
      <SettingsRow
        label="Tenant concurrency limit"
        labelFor="tenant-concurrency-limit"
        hint="Ceiling on requests in flight across every key in this tenant at once. Empty means no tenant-wide ceiling — each key is then bounded only by its own limit."
        control={
          <Input
            id="tenant-concurrency-limit"
            aria-label="Tenant concurrency limit"
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            placeholder="No ceiling"
            value={settings.tenantConcurrencyLimit?.toString() ?? ""}
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (raw === "") {
                save({ tenantConcurrencyLimit: null }, "Tenant ceiling removed.");
                return;
              }
              const parsed = Number(raw);
              // The route rejects anything but a positive integer, so a partial
              // entry is held in the field rather than sent — otherwise typing
              // "1" on the way to "12" would save 1 and bounce the value back.
              if (!Number.isInteger(parsed) || parsed < 1) return;
              save({ tenantConcurrencyLimit: parsed }, "Tenant concurrency limit updated.");
            }}
          />
        }
      />
      <SettingsRow
        label="Concurrency tolerance"
        labelFor="concurrency-tolerance"
        hint="Slack added above a key's own concurrency limit. The effective ceiling is the key's limit plus this, so a run landing a few over is not refused at the number it was told."
        control={
          <Input
            id="concurrency-tolerance"
            aria-label="Concurrency tolerance"
            type="number"
            min="0"
            max="1024"
            step="1"
            inputMode="numeric"
            placeholder="None"
            value={settings.concurrencyTolerance?.toString() ?? ""}
            onChange={(event) => {
              const raw = event.target.value.trim();
              if (raw === "") {
                save({ concurrencyTolerance: null }, "Tolerance removed.");
                return;
              }
              const parsed = Number(raw);
              // 0–1024, the range the store clamps to. Held rather than sent
              // while it is out of range, so a mistyped digit does not persist.
              if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1024) return;
              save({ concurrencyTolerance: parsed }, "Concurrency tolerance updated.");
            }}
          />
        }
      />

      {/*
       * Bounded numbers, each a fixed set rather than a free number field. An
       * operator picking a timeout is choosing among values that make sense,
       * and a dropdown cannot hold a typo the backend then silently clamps —
       * "6000" in a number box reads as accepted until it is quietly stored
       * as 600.
       */}
      <SettingsGroup title="Request handling" />
      <SettingsRow
        label="Upstream timeout"
        labelFor="upstream-timeout"
        hint={`5–600 seconds, ${settings.defaults.upstreamTimeoutSeconds}s when unset. Applied when the request is dispatched, so it can only shorten a deadline that has already started.`}
        control={
          <Select
            aria-label="Upstream timeout"
            id="upstream-timeout"
            value={settings.upstreamTimeoutSeconds?.toString() ?? ""}
            placeholder={defaultLabel(
              `${settings.defaults.upstreamTimeoutSeconds} seconds`,
            )}
            onValueChange={(value) =>
              save(
                { upstreamTimeoutSeconds: value === "" ? null : Number(value) },
                "Upstream timeout updated.",
              )
            }
            options={[
              ...boundedOptions(
                TIMEOUT_CHOICES,
                settings.upstreamTimeoutSeconds,
                (v) => `${v} seconds`,
              ),
              {
                value: "",
                label: defaultLabel(
                  `${settings.defaults.upstreamTimeoutSeconds} seconds`,
                ),
              },
            ]}
          />
        }
      />
      <SettingsRow
        label="Request detail window"
        labelFor="telemetry-window-minutes"
        hint={`1–1440 minutes, ${formatMinutes(settings.defaults.telemetryWindowMinutes)} when unset. Controls how long captured payload frames are kept — the same number Data Management reports as what payload frames expire after. Raw request events follow the ${settings.defaults.telemetryRetentionDays}-day server retention instead.`}
        control={
          <Select
            aria-label="Request detail window"
            id="telemetry-window-minutes"
            value={settings.telemetryWindowMinutes?.toString() ?? ""}
            placeholder={defaultLabel(
              formatMinutes(settings.defaults.telemetryWindowMinutes),
            )}
            onValueChange={(value) =>
              save(
                { telemetryWindowMinutes: value === "" ? null : Number(value) },
                "Detail window updated.",
              )
            }
            options={[
              ...boundedOptions(
                WINDOW_CHOICES,
                settings.telemetryWindowMinutes,
                formatMinutes,
              ),
              {
                value: "",
                label: defaultLabel(
                  formatMinutes(settings.defaults.telemetryWindowMinutes),
                ),
              },
            ]}
          />
        }
      />
      <SettingsRow
        label="Max attachment size"
        labelFor="image-clamp-max-bytes"
        hint={`Per image, ${formatMegabytes(settings.defaults.imageClampMaxBytes)} when unset. An oversized attachment is refused before send rather than after the upstream rejects it — a block too large poisons every retry and every replayed turn. Raising this asserts your upstreams accept more; lowering it is the safer direction. Applies to the Messages and Gemini wires.`}
        control={
          <Select
            aria-label="Max attachment size"
            id="image-clamp-max-bytes"
            value={
              settings.imageClampMaxBytes === null
                ? ""
                : String(
                    Math.round(settings.imageClampMaxBytes / (1024 * 1024)),
                  )
            }
            placeholder={defaultLabel(
              formatMegabytes(settings.defaults.imageClampMaxBytes),
            )}
            onValueChange={(value) =>
              save(
                {
                  imageClampMaxBytes:
                    value === "" ? null : Number(value) * 1024 * 1024,
                },
                "Attachment size limit updated.",
              )
            }
            options={[
              ...boundedOptions(
                ATTACHMENT_CHOICES,
                settings.imageClampMaxBytes === null
                  ? null
                  : Math.round(settings.imageClampMaxBytes / (1024 * 1024)),
                (v) => `${v} MB`,
              ),
              {
                value: "",
                label: defaultLabel(
                  formatMegabytes(settings.defaults.imageClampMaxBytes),
                ),
              },
            ]}
          />
        }
      />

      <SettingsGroup title="Response shaping" />
      <SettingsRow
        label="Thinking normalization"
        labelFor="thinking-normalization"
        hint="Rewrite a provider's native thinking config into the canonical shape on turns where the user is not the final reader. Off by default: the upstream's own config is passed through untouched."
        control={
          <Select
            aria-label="Thinking normalization"
            id="thinking-normalization"
            value={settings.thinkingNormalizationEnabled ? "on" : "off"}
            onValueChange={(value) => {
              const next = value === "on";
              save(
                { thinkingNormalizationEnabled: next },
                next
                  ? "Thinking config will be normalized."
                  : "Upstream thinking config is left as sent.",
              );
            }}
            options={[
              { value: "off", label: "Off — default" },
              { value: "on", label: "On" },
            ]}
          />
        }
      />
      <SettingsRow
        label="Reasoning summary"
        labelFor="responses-reasoning-summary"
        hint="Verbosity of the reasoning summary on the Responses wire, forced even when a request carries no reasoning block. Applies when the routed model is Responses and the client called a Chat surface."
        control={
          <Select
            aria-label="Reasoning summary"
            id="responses-reasoning-summary"
            value={settings.responsesReasoningSummary}
            onValueChange={(value) =>
              save(
                {
                  responsesReasoningSummary:
                    value === "concise" || value === "detailed"
                      ? value
                      : "auto",
                },
                "Reasoning summary updated.",
              )
            }
            options={[
              { value: "auto", label: "Auto — follow the request" },
              { value: "concise", label: "Concise" },
              { value: "detailed", label: "Detailed — default" },
            ]}
          />
        }
      />
    </>
  );
}

function PasswordChangeForm(): ReactNode {
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const submit = () => {
    setSuccess(false);
    if (newPassword.length < 8) {
      setFormError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError("New password and confirmation do not match.");
      return;
    }
    setFormError(null);
    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setSuccess(true);
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
        },
        onError: (error) =>
          setFormError(getErrorMessage(error, "Password change failed.")),
      },
    );
  };

  return (
    <>
      <SettingsRow
        label="Current password"
        labelFor="current-password"
        hint="This is the password for this console, not for any upstream provider. Provider credentials live on each provider in Providers."
        control={
          <Input
            id="current-password"
            aria-label="Current password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        }
      />
      <SettingsRow
        label="New password"
        labelFor="new-password"
        hint="Minimum 8 characters. A passphrase is easier to remember and harder to guess."
        control={
          <Input
            id="new-password"
            aria-label="New password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        }
      />
      <SettingsRow
        label="Confirm new password"
        labelFor="confirm-password"
        control={
          <Input
            id="confirm-password"
            aria-label="Confirm new password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        }
      />
      {formError ? (
        <p role="alert" className="settings-feedback" data-tone="err">
          {formError}
        </p>
      ) : null}
      {success ? (
        <p role="status" className="settings-feedback" data-tone="ok">
          Password updated.
        </p>
      ) : null}
      <div className="settings-actions">
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={
            changePassword.isPending ||
            !currentPassword ||
            !newPassword ||
            !confirmPassword
          }
        >
          {changePassword.isPending ? "Updating…" : "Update password"}
        </Button>
      </div>
    </>
  );
}

/**
 * What each section's card holds.
 *
 * A record keyed by `SectionId` rather than a chain of JSX so adding a
 * section without a body is a type error here, not a blank card.
 */
const PANEL_BODY: Record<SectionId, ReactNode> = {
  security: <PasswordChangeForm />,
  privacy: <PrivacyPanel />,
  operations: <OperationalPanel />,
  backup: <BackupPanel />,
  "data-management": <DataManagementPanel />,
};

/**
 * The sections that share a row instead of taking one each.
 *
 * Security and Privacy are the two short ones — three password fields, three
 * dropdowns — so side by side they fill a row of about the height either
 * would take alone, and the page is one screen shorter for it. Operations,
 * Backup, and Data Management stay full width: Operations runs seven rows
 * across four groups, Backup is a two-column form of its own, and Data
 * Management is a row of cards. Squeezing any of them into a half-width
 * column wraps nearly every line and buries the control under its own hint.
 */
const SIDE_BY_SIDE: readonly SectionId[] = ["security", "privacy"];

export default function Settings(): ReactNode {
  return (
    <div className="settings-page">
      {/*
       * No page header here. The console shell already renders one for this
       * route — "Settings" with its own subtitle, in the topbar — so a
       * heading inside the content repeated the title directly under it.
       */}
      {/*
       * Every section is on the page at once, so an operator finds a setting
       * by looking rather than by guessing which heading hides it. The two
       * short sections share a row; everything else is full width, one per
       * row, in this order.
       */}
      {/*
       * The pair, side by side. `auto-fit` with a floor rather than a fixed
       * two columns: below the floor they stack on their own, so a narrow
       * window gets one column without a breakpoint to keep in sync.
       */}
      <div className="settings-grid">
        {SIDE_BY_SIDE.map((id) => {
          const section = SECTIONS.find((s) => s.id === id);
          if (!section) return null;
          return (
            <SettingsSection
              key={id}
              id={section.id}
              title={section.title}
              description={section.description}
            >
              {PANEL_BODY[section.id]}
            </SettingsSection>
          );
        })}
      </div>
      {SECTIONS.filter((s) => !SIDE_BY_SIDE.includes(s.id)).map((section) => (
        <SettingsSection
          key={section.id}
          id={section.id}
          title={section.title}
          description={section.description}
        >
          {PANEL_BODY[section.id]}
        </SettingsSection>
      ))}
    </div>
  );
}
