import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { type CSSProperties, type ReactNode } from "react";

import { FormField } from "../patterns/form-field";
import { cn } from "../../lib/classnames";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly value: string;
  readonly onValueChange?: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly label?: string;
  readonly "aria-label"?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly style?: CSSProperties;
  readonly className?: string;
  readonly size?: "sm" | "md" | "lg";
  readonly error?: string;
}

/**
 * Height is a static prop, so it is a utility rather than an inline style. The
 * sheet already sets 36px on `.radix-select-trigger`; the map re-expresses the
 * three sizes on the `--spacing: 2px` scale (`h-15` = 30px, `h-18` = 36px,
 * `h-22` = 44px). A caller-supplied `style.height` still wins, because an inline
 * declaration outranks a class.
 */
const SIZE_HEIGHT_CLASS: Record<NonNullable<SelectProps["size"]>, string> = {
  sm: "h-15",
  md: "h-18",
  lg: "h-22",
};

/**
 * The value handed to Radix, with its reserved empty string translated away.
 *
 * Radix treats `""` as "nothing selected" — `Select.Value` falls back to its
 * placeholder for it, exactly as it does for `undefined`. A controlled `""`
 * therefore renders "Select…" even when the caller's state names a real
 * selection. Exported so the translation is pinned without a DOM: mounting
 * Radix and asserting on what the trigger paints is the only other way to see
 * it, and `dashboard/test` has no mount helper yet.
 */
export function radixRootValue(value: string): string | undefined {
  return value === "" ? undefined : value;
}

/**
 * Whether an option with this value may be picked.
 *
 * The empty string is Radix's placeholder convention, so a bare `""` emission
 * cannot be accepted blindly — storing it is what made the API-format dropdown
 * read as reset after every pick. But `""` is also a legitimate value for a
 * caller that spells "no choice" that way: the routing card's Client identity
 * offers `{ value: "", label: "None" }`, and refusing it made picking None do
 * nothing at all — the handler returned before calling `onValueChange`, so the
 * stored identity never changed and the control looked inert.
 *
 * The two are told apart by the options list: an `""` the caller published as a
 * labelled option is a real choice, while an `""` that no option carries is the
 * placeholder convention leaking through.
 */
export function isSelectableValue(next: string, options: readonly SelectOption[] = []): boolean {
  if (next !== "") return true;
  return options.some((option) => option.value === "");
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  label,
  "aria-label": ariaLabelProp,
  disabled,
  id,
  style,
  className = "",
  size = "md",
  error,
}: SelectProps): ReactNode {
  const rootValue = radixRootValue(value);
  const handler = (next: string): void => {
    if (!isSelectableValue(next, options)) return;
    onValueChange?.(next);
  };
  // Resolved against the caller's own value, not Radix's root value: `None` is
  // a real selection (`""`), and reading the label from `rootValue` — which is
  // `undefined` for it — would render the placeholder instead of "None".
  const selectedLabel = options.find((option) => option.value === value)?.label;


  const trigger = (
    <RadixSelect.Root value={rootValue} onValueChange={handler} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabelProp ?? label}
        // `cn` (twMerge), not a template string: `size` emits a height class and a
        // caller may pass its own (`h-16` for a 32px control in a toolbar). Two
        // same-specificity height classes would otherwise be resolved by stylesheet
        // order, not by the caller's intent, and the control would silently take the
        // atom's size instead of the one asked for.
        className={cn(
          // `text-body` (13px) matches the label above it. At `text-caption`
          // (12px) the selected value read as subordinate to its own label and
          // the same size as the help text beneath — so a field's three parts
          // had two sizes between them and no clear order.
          "radix-select-trigger inline-flex items-center justify-between gap-4 w-full px-6 rounded-control border border-inner-border bg-surface-2 text-text-primary text-body font-sans text-left cursor-pointer transition-[border-color,background-color] duration-150 ease-spring hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-1 aria-disabled:opacity-70 aria-disabled:cursor-default aria-disabled:pointer-events-none [&_svg]:text-text-tertiary [&_svg]:transition-transform [&_svg]:duration-150 [&_svg]:ease-spring data-[state=open]:[&_svg]:rotate-180",
          SIZE_HEIGHT_CLASS[size],
          className,
        )}
        style={{
          ...style,
          // Runtime-computed (depends on `disabled`), so they stay inline: the
          // sheet's `[aria-disabled]` rule cannot outrank an inline declaration,
          // and these deliberately differ from it (0.6 vs 0.72, not-allowed vs
          // default). Moving them to classes would silently change the render.
          opacity: disabled ? 0.6 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        <RadixSelect.Value placeholder={placeholder}>{selectedLabel ?? placeholder}</RadixSelect.Value>
        <RadixSelect.Icon asChild>
          <ChevronDown size={14} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="radix-select-content radix-select-content-fit z-toast min-w-[var(--radix-select-trigger-width)] max-h-140 max-h-[var(--radix-select-content-available-height)] overflow-hidden overflow-y-auto border border-border-strong rounded-card bg-popover-bg shadow-popout backdrop-blur-xl p-2.5 box-border"
        >
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="radix-select-item flex items-center justify-between gap-4 px-5 py-4 rounded-control text-caption font-medium text-text-primary cursor-pointer outline-none transition-colors duration-150 select-none data-[highlighted]:bg-surface-hover data-[state=checked]:font-semibold data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed"
                textValue={option.label}
              >
                <span>{option.label}</span>
                <RadixSelect.ItemIndicator className="radix-select-indicator inline-flex items-center text-accent">
                  <Check size={14} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );

  if (!label) return trigger;

  return <FormField label={label} error={error} htmlFor={id}>{trigger}</FormField>;
}
