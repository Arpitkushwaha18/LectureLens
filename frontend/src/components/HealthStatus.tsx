import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { useHealth } from "@/hooks/useHealth";
import { cn } from "@/lib/cn";

/**
 * Live indicator for the backend. Real request, real state — no mocked
 * "connected" badge. If the API is down, the user can retry.
 */
export function HealthStatus() {
  const { data, isPending, isError, isFetching, refetch } = useHealth();

  const dot = cn(
    "size-1.5 shrink-0 rounded-full",
    isPending && "bg-ink-muted/60",
    !isPending && !isError && "bg-olive",
    isError && "bg-terracotta",
  );

  const label = isPending
    ? "Checking connection"
    : isError
      ? "Offline"
      : data?.status === "ok"
        ? "Connected"
        : "Connection limited";

  return (
    <div className="flex shrink-0 items-center gap-1.5 sm:gap-2" aria-live="polite">
      <span
        className={cn(
          "inline-flex items-center gap-2 rounded-full border px-2 py-1.5 text-[11px] font-medium sm:px-2.5 sm:py-1",
          isError
            ? "border-terracotta/30 bg-terracotta-soft/60 text-terracotta-deep"
            : "border-rule-strong bg-surface text-ink-soft",
        )}
        title={
          data
            ? `${data.service} v${data.version} · ${data.environment} · up ${Math.round(data.uptimeSeconds)}s`
            : undefined
        }
      >
        <span className={dot} aria-hidden="true" />
        <span className="whitespace-nowrap">{label}</span>
      </span>

      {isError ? (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void refetch()}
          disabled={isFetching}
          aria-label="Retry connection check"
          className="text-ink-muted"
        >
          <RotateCw className={cn("size-4", isFetching && "animate-spin")} aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
