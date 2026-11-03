import { Component, type ErrorInfo, type ReactNode } from "react";
import AuthLayout from "../features/session/AuthLayout";

interface ErrorBoundaryProps {
  /** Distinguishes navigation targets. A change clears a recovered error so a
   * transient lazy-chunk load failure at one route never pins the whole shell
   * to the error surface when the user navigates elsewhere. */
  readonly resetKey: string;
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
  /** Which component threw. Surfaced in the UI because the console log is not
   * reachable from a browser the operator only sees the rendered page on. */
  readonly componentStack: string | null;
}

/**
 * Root error boundary for the console shell. Lazy route imports can fail on a
 * transient chunk fetch; rather than leaving a blank viewport the boundary
 * renders a recoverable surface and offers a full reload as the last resort.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, componentStack: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[console] route render failed:", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  override componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const componentStack = this.state.componentStack?.trim();
    const errorStack = this.state.error.stack?.trim();
    const trace =
      componentStack !== undefined && componentStack.length > 0
        ? componentStack
        : errorStack !== undefined && errorStack.length > 0
          ? errorStack
          : null;
    return (
      <AuthLayout
        title="Console view failed"
        description="This view could not be rendered."
      >
        <div className="rounded-panel border border-inner-border bg-surface-2 p-7 leading-normal text-caption text-text-secondary">
          <strong className="block text-text-primary mb-2">
            Rendering error
          </strong>
          <span className="select-text break-words">
            {this.state.error.message}
          </span>
          {/* One trace, not two. `componentStack` and `error.stack` name the
              same failure and overlap almost entirely, so showing both read
              as the same error printed twice. The component stack wins when
              present because it names the component that threw; the raw stack
              is the fallback for an error caught without one. */}
          {trace !== null ? (
            <pre className="mt-4 max-h-80 overflow-auto whitespace-pre-wrap break-words text-badge text-text-tertiary">
              {trace}
            </pre>
          ) : null}
        </div>

        <button
          type="button"
          className="btn btn-primary inline-flex w-full items-center justify-center rounded-control bg-accent font-semibold text-accent-foreground mt-3 h-20 text-caption"
          onClick={() => window.location.reload()}
        >
          Reload console
        </button>
      </AuthLayout>
    );
  }
}