import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "./button";

/**
 * Prev/Next pager for lists that would otherwise overflow the surface. Renders
 * nothing on a single page so callers can mount it unconditionally.
 */
export function PaginationControls({
  page,
  pageCount,
  onPageChange,
  testId,
}: {
  readonly page: number;
  readonly pageCount: number;
  readonly onPageChange: (page: number) => void;
  readonly testId?: string;
}): ReactNode {
  if (pageCount <= 1) return null;
  return (
    <div data-testid={testId} className="flex items-center justify-end gap-3">
      <span className="text-badge tabular-nums text-text-tertiary">
        Page {page} of {pageCount}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        icon={<ChevronLeft size={13} />}
      >
        Previous
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        icon={<ChevronRight size={13} />}
      >
        Next
      </Button>
    </div>
  );
}
