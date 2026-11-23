import { useState, type FormEvent } from "react";
import { ArrowUp } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";

export function TutorSearchBar() {
  const [prompt, setPrompt] = useState("");
  const navigate = useNavigate();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (prompt.trim().length < 3) return;
    // Keep private questions out of URLs, access logs and referrers.
    navigate("/ask", { state: { prompt: prompt.trim() } });
  }
  return (
    <form
      role="search"
      aria-label="Ask UrTutor"
      onSubmit={submit}
      className="mx-auto mt-5 flex max-w-2xl items-center gap-2 rounded-full border border-rule-strong bg-paper p-2 shadow-paper focus-within:border-navy/50"
    >
      <input
        aria-label="Ask a doubt or request notes"
        placeholder="Ask a doubt or request notes…"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        maxLength={4000}
        className="min-w-0 flex-1 bg-transparent px-4 py-2 text-sm outline-none"
      />
      <Button
        type="submit"
        size="icon"
        aria-label="Ask UrTutor"
        disabled={prompt.trim().length < 3}
        className="rounded-full"
      >
        <ArrowUp className="size-4" aria-hidden="true" />
      </Button>
    </form>
  );
}
