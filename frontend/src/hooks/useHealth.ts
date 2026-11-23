import { useQuery } from "@tanstack/react-query";

import { getHealth } from "@/lib/api";

/**
 * Polls the backend health endpoint. This is the only "server state" in
 * Phase 1 and it proves the frontend -> API wiring end to end.
 */
export function useHealth() {
  return useQuery({
    queryKey: ["system", "health"],
    queryFn: ({ signal }) => getHealth(signal),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}
