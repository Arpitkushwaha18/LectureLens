import { useEffect, useRef, useState } from "react";
import type {
  WorkspaceEvent,
  WorkspaceResult,
  PublicSource,
  GenerationOutputTypeV2,
} from "@lecturelens/contracts";
import { API_BASE_URL } from "@/lib/api";
import { processSource } from "./workspace-api";

export function useWorkspaceRun() {
  const active = useRef<AbortController | null>(null);
  const last = useRef<{ options: unknown; file: File | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<Extract<WorkspaceEvent, { event: "stage" }> | null>(null);
  const [result, setResult] = useState<WorkspaceResult | null>(null);
  const [source, setSource] = useState<PublicSource | null>(null);
  const [materials, setMaterials] = useState<
    Extract<WorkspaceResult, { status: "ready" }>["materials"]
  >([]);
  const [outputStates, setOutputStates] = useState<Partial<Record<GenerationOutputTypeV2, string>>>(
    {},
  );
  const [error, setError] = useState<{
    message: string;
    retryable: boolean;
    blocked: boolean;
    retryAt: number;
  } | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  function reset() {
    if (active.current) return;
    setResult(null);
    setSource(null);
    setError(null);
    setStage(null);
    setProgress(0);
    setMaterials([]);
    setOutputStates({});
    last.current = null;
  }
  async function start(options: unknown, file: File | null, remember = true) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const retained = remember ? [] : materials;
    if (remember) {
      last.current = { options, file };
      setMaterials([]);
      setOutputStates({});
      setSource(null);
    }
    setBusy(true);
    setProgress(0);
    setError(null);
    setResult(null);
    setStage({ event: "stage", stage: "validating", message: "Uploading your selection" });
    try {
      await processSource(API_BASE_URL, options, file, controller.signal, (event) => {
        if (controller.signal.aborted) return;
        if (event.event === "progress") setProgress(event.percent === 100 ? 95 : event.percent);
        if (event.event === "stage") {
          setStage(event);
          if (event.outputType && event.outputStatus)
            setOutputStates((v) => ({ ...v, [event.outputType!]: event.outputStatus! }));
        }
        if (event.event === "source") setSource(event.source);
        if (event.event === "material")
          setMaterials((v) => [
            ...v.filter((m) => m.outputType !== event.material.outputType),
            event.material,
          ]);
        if (event.event === "result") {
          if (event.result.status === "ready") {
            const received = event.result.materials;
            const combined = [
              ...retained.filter((m) => !received.some((n) => n.outputType === m.outputType)),
              ...received,
            ];
            setMaterials(combined);
            setResult({ ...event.result, materials: combined });
            setProgress(100);
            if (event.result.failures?.length)
              setError({
                message:
                  "Some materials couldn’t be prepared. Your completed materials are still available below.",
                retryable: true,
                blocked: false,
                retryAt: 0,
              });
          } else setResult(event.result);
        }
        if (event.event === "error")
          setError({
            message:
              event.code.startsWith("GEMINI_") || event.code.startsWith("GENERATION_")
                ? "Generation couldn’t be completed right now. Please retry."
                : event.message,
            retryable: true,
            blocked: false,
            retryAt: 0,
          });
      });
    } catch (failure) {
      if (!controller.signal.aborted)
        setError({
          message:
            failure instanceof Error
              ? failure.message
              : "The connection was interrupted. Please retry.",
          retryable: true,
          blocked: false,
          retryAt: 0,
        });
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
        setStage(null);
      }
    }
  }
  function retry() {
    if (!last.current) return;
    const failed =
      result?.status === "ready" ? result.failures?.map((f) => f.outputType) : undefined;
    void start(
      failed?.length
        ? { ...(last.current.options as object), outputTypes: failed }
        : last.current.options,
      last.current.file,
      false,
    );
  }
  return {
    busy,
    progress,
    stage,
    result,
    source,
    materials,
    outputStates,
    error,
    start,
    reset,
    dismissFailure: reset,
    cancel: () => active.current?.abort(),
    retry,
    retryAfterSeconds: 0,
    check: retry,
  };
}
