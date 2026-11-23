import { useEffect, useRef, useState } from "react";
import type {
  WorkspaceEvent,
  WorkspaceResult,
  PublicSource,
  GenerationOutputTypeV2,
} from "@lecturelens/contracts";
import { API_BASE_URL } from "@/lib/api";
import { processSource } from "./workspace-api";
import { openStudySession } from "@/features/library/library-api";

export function useWorkspaceRun() {
  const active = useRef<AbortController | null>(null);
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
  const last = useRef<{ options: unknown; file: File | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pendingRetryAt, setPendingRetryAt] = useState(0);
  useEffect(() => {
    if (!error?.retryable && !(result?.status === "pending" && result.retrySafe)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [error, result]);
  useEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  function reset() {
    if (!active.current) {
      setResult(null);
      setSource(null);
      setError(null);
      setStage(null);
      setProgress(0);
      setMaterials([]);
      setOutputStates({});
      last.current = null;
    }
  }
  function dismissFailure() {
    if (active.current) return;
    setError(null);
    setResult(null);
    setStage(null);
    setProgress(0);
    setSource(null);
    setMaterials([]);
    setOutputStates({});
    last.current = null;
  }
  async function start(options: unknown, file: File | null, remember = true) {
    if (active.current) return;
    const continuing =
      last.current?.file === file &&
      JSON.stringify(last.current.options) === JSON.stringify(options);
    // A repeated Continue must not clear a known cooldown. Read-only result
    // checks remain available and the server still enforces its durable fence.
    if (continuing && remember && Date.now() < (error?.retryAt ?? pendingRetryAt)) return;
    if (!continuing && remember) {
      setMaterials([]);
      setOutputStates({});
    }
    if (remember) last.current = { options, file };
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setProgress(0);
    setError(null);
    setResult(null);
    setPendingRetryAt(0);
    if (!continuing && remember) setSource(null);
    setStage({
      event: "stage",
      stage: "validating",
      message: "Validating source and uploading your selection",
    });
    let submitted = false;
    try {
      const session = await openStudySession();
      if (!session.ownerId)
        throw new Error("Sign in to save your private study resources before generating.");
      submitted = true;
      await processSource(API_BASE_URL, options, file, controller.signal, (event) => {
        if (controller.signal.aborted) return;
        if (event.event === "progress")
          setProgress((v) => Math.max(v, event.percent === 100 ? 95 : event.percent));
        if (event.event === "stage") {
          setStage(event);
          if (event.outputType && event.outputStatus)
            setOutputStates((v) => ({ ...v, [event.outputType!]: event.outputStatus! }));
        }
        if (event.event === "material")
          setMaterials((v) => [
            ...v.filter((m) => m.outputType !== event.material.outputType),
            event.material,
          ]);
        if (event.event === "source") setSource(event.source);
        if (event.event === "result") {
          setResult(event.result);
          if (event.result.status === "ready") {
            setMaterials(event.result.materials);
            setProgress(100);
          }
          if (event.result.status === "pending" && event.result.retrySafe) {
            setNow(Date.now());
            setPendingRetryAt(Date.now() + event.result.retryAfterSeconds * 1000);
          }
        }
        if (event.event === "error") {
          setNow(Date.now());
          setError({
            message: event.message,
            retryable: event.retryable,
            blocked: [
              "JOB_RECOVERY_REQUIRED",
              "GEMINI_TIMEOUT",
              "GEMINI_CONNECTION",
              "GEMINI_UNCERTAIN",
              "JOB_LEASE_LOST",
            ].includes(event.code),
            retryAt: Date.now() + (event.retryAfterSeconds ?? 0) * 1000,
          });
        }
      });
    } catch (failure) {
      if (!controller.signal.aborted)
        setError({
          message: submitted
            ? "We're checking your previous generation. We haven't started another request to avoid duplicate charges."
            : (failure as Error).message,
          retryable: false,
          blocked: submitted,
          retryAt: 0,
        });
    } finally {
      if (active.current === controller) {
        active.current = null;
        setBusy(false);
      }
    }
  }
  function cancel() {
    if (stage?.stage === "extracting" || stage?.stage === "validating") active.current?.abort();
  }
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil(((error?.retryAt ?? pendingRetryAt) - now) / 1000),
  );
  function retry() {
    if (
      ((error?.retryable && Date.now() >= error.retryAt) ||
        (result?.status === "pending" && result.retrySafe && Date.now() >= pendingRetryAt)) &&
      last.current
    )
      void start(last.current.options, last.current.file);
  }
  function check() {
    if (last.current)
      void start(
        { ...(last.current.options as object), checkOnly: true },
        last.current.file,
        false,
      );
  }
  return {
    busy,
    progress,
    materials,
    outputStates,
    stage,
    result,
    source,
    error,
    start,
    reset,
    dismissFailure,
    cancel,
    retry,
    retryAfterSeconds,
    check,
  };
}
