import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { ArrowUp, Sparkles } from "lucide-react";
import { notebookSchema, type Notebook as NotebookData } from "@lecturelens/contracts";
import { Button } from "@/components/ui/Button";
import { Notebook } from "@/features/notebook/Notebook";
import { API_BASE_URL } from "@/lib/api";
import { openStudySession } from "@/features/library/library-api";
import { Link } from "react-router-dom";

type Turn = {
  id: string;
  prompt: string;
  status: "pending" | "done" | "error";
  answer?: NotebookData;
  error?: string;
};

const suggestions = [
  "Explain this topic in simple terms",
  "Make quick revision notes",
  "Quiz me on a concept",
];

/** Dedicated GPT-style answer page, reached by submitting the workspace search bar. */
export function TutorChat({ initialPrompt = "" }: { initialPrompt?: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null),
    threadRef = useRef<HTMLDivElement>(null),
    request = useRef<AbortController | null>(null),
    alive = useRef(true);
  const [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [turns, setTurns] = useState<Turn[]>([]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, busy]);

  function grow(node: HTMLTextAreaElement) {
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }

  const send = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      if (busy || prompt.length < 3) return;
      const id = crypto.randomUUID();
      setTurns((previous) => [...previous, { id, prompt, status: "pending" }]);
      setDraft("");
      if (inputRef.current) inputRef.current.style.height = "auto";
      setBusy(true);
      const controller = new AbortController();
      request.current = controller;
      try {
        await openStudySession();
        const response = await fetch(`${API_BASE_URL}/workspace/ask`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-LectureLens-Request": "1" },
          body: JSON.stringify({ prompt }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(360000)]),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok)
          throw new Error(
            response.status === 429
              ? "Please wait a moment before asking another question."
              : body?.error?.code === "TUTOR_PENDING"
                ? "Your previous answer is still being checked. Ask a different question."
                : "This answer could not be completed. Try another question or come back later.",
          );
        const result = notebookSchema.safeParse(body?.data?.notebook);
        if (!result.success)
          throw new Error("This answer could not be read. Please ask another question.");
        if (alive.current)
          setTurns((previous) =>
            previous.map((turn) =>
              turn.id === id ? { ...turn, status: "done", answer: result.data } : turn,
            ),
          );
      } catch {
        if (!alive.current) return;
        if (controller.signal.aborted) {
          setTurns((previous) => previous.filter((turn) => turn.id !== id));
          return;
        }
        const message = "This answer could not be completed. Please try again later.";
        setTurns((previous) =>
          previous.map((turn) =>
            turn.id === id ? { ...turn, status: "error", error: message } : turn,
          ),
        );
      } finally {
        if (request.current === controller) request.current = null;
        if (alive.current) setBusy(false);
      }
    },
    [busy],
  );

  function retry(turn: Turn) {
    setTurns((previous) => previous.filter((item) => item.id !== turn.id));
    void send(turn.prompt);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(draft);
    }
  }
  const initialSent = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    // A microtask plus the ref prevents StrictMode's effect replay from sending twice.
    queueMicrotask(() => {
      if (!alive.current || initialSent.current || !initialPrompt.trim()) return;
      initialSent.current = true;
      void send(initialPrompt);
    });
  }, [initialPrompt, send]);
  return (
    <section
      aria-labelledby="tutor-title"
      className="mx-auto flex h-[calc(100dvh-8rem)] min-h-[28rem] max-w-4xl flex-col overflow-hidden rounded-2xl border border-rule bg-paper"
    >
      <header className="flex items-start justify-between gap-3 border-b border-rule bg-surface/70 px-4 py-3">
        <div>
          <p className="label-caps text-olive">Your question, a fresh page</p>
          <h2 id="tutor-title" className="mt-1 text-xl">
            Ask UrTutor
          </h2>
        </div>
        <Link to="/assistant" className="text-sm text-navy hover:underline">
          Back to workspace
        </Link>
      </header>

      <div
        ref={threadRef}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-5"
        aria-live="polite"
      >
        {turns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-rule bg-surface/50 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-navy">
              <Sparkles className="size-4" aria-hidden="true" /> Ask anything
            </p>
            <p className="mt-1 text-xs text-ink-muted">
              Clear a doubt or request notes on any topic. Lecture and document material stays in
              the workspace.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="rounded-full border border-rule bg-paper px-3 py-1.5 text-left text-xs text-ink-soft hover:border-navy/40 hover:text-ink"
                  onClick={() => {
                    setDraft(suggestion);
                    inputRef.current?.focus();
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn) => (
          <div key={turn.id} className="space-y-3">
            <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-navy px-4 py-2.5 text-sm text-surface">
              {turn.prompt}
            </p>
            {turn.status === "pending" ? (
              <p role="status" className="text-sm text-ink-muted">
                Preparing your answer…
              </p>
            ) : null}
            {turn.status === "error" ? (
              <div
                role="alert"
                className="rounded-xl border border-terracotta/40 bg-terracotta-soft p-3"
              >
                <p className="text-sm text-terracotta-deep">{turn.error}</p>
                <div className="mt-2 flex gap-2">
                  <Button type="button" size="sm" onClick={() => retry(turn)}>
                    Try again
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setTurns((previous) =>
                        previous.map((item) =>
                          item.id === turn.id
                            ? { ...item, status: "done", error: undefined }
                            : item,
                        ),
                      )
                    }
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            ) : null}
            {turn.answer ? (
              <div className="rounded-xl border border-rule bg-surface/60 p-3">
                <Notebook notebook={turn.answer} />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <form onSubmit={onSubmit} className="border-t border-rule bg-surface/70 p-3">
        <div className="flex items-end gap-2 rounded-2xl border border-rule-strong bg-paper p-2 shadow-[inset_0_1px_0_rgba(0,0,0,0.03)] focus-within:border-navy/50">
          <textarea
            id="tutor-message"
            ref={inputRef}
            value={draft}
            aria-label="Message UrTutor"
            placeholder="Ask a doubt or request notes…"
            rows={1}
            maxLength={4000}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-ink-muted"
            onChange={(event) => setDraft(event.target.value)}
            onInput={(event) => grow(event.currentTarget)}
            onKeyDown={onKeyDown}
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send message"
            disabled={busy || draft.trim().length < 3}
            className="rounded-full"
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <p className="mt-1.5 px-2 text-[10px] text-ink-muted">
          Enter to send · Shift + Enter for a new line. Answers are saved privately to your session.
        </p>
      </form>
    </section>
  );
}
