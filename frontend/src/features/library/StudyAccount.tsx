import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { libraryRequest, openStudySession } from "./library-api";
import { useQueryClient } from "@tanstack/react-query";
export function StudyAccount() {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Awaited<ReturnType<typeof openStudySession>> | null>(null),
    [open, setOpen] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void openStudySession()
      .then(setSession)
      .catch(() => setMessage("Study storage is offline"));
  }, []);
  async function auth(action: "login" | "signup" | "logout") {
    setBusy(true);
    try {
      const result = await libraryRequest(`/auth/${action}`, {
        method: "POST",
        body: action === "logout" ? undefined : JSON.stringify({ email, password }),
      });
      setPassword("");
      setMessage(result.data.message ?? "Signed out.");
      setSession(await openStudySession(true));
      queryClient.clear();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="study-account">
      <button
        type="button"
        className="text-xs text-navy"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {session?.ownerId
          ? session.mode === "guest"
            ? "My study session"
            : "My account"
          : "Sign in"}
      </button>
      {open ? (
        <section className="account-popover">
          <h2 className="text-xl">Your study corner</h2>
          {session?.mode === "guest" ? (
            <p className="text-xs">
              Your uploads belong to this device’s private study session. Activity answers stay in
              the current tab.
            </p>
          ) : session?.ownerId ? (
            <>
              <p>You’re signed in. Your attempts are private.</p>
              <Button onClick={() => void auth("logout")}>Sign out</Button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void auth("login");
              }}
            >
              <label>
                Email
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </label>
              <label>
                Password
                <input
                  required
                  type="password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <Button type="submit" disabled={busy}>
                Sign in
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void auth("signup")}
                disabled={busy}
              >
                Create account
              </Button>
            </form>
          )}
          {message ? <p role="status">{message}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
