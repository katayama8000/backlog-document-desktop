import { type FormEvent, useRef, useState } from "react";
import { api, errorMessage, isCommandError } from "../api";

type Props = {
  initialSpaceUrl: string;
  /** The build can sign in with OAuth; otherwise only an API key works. */
  oauthAvailable: boolean;
  onConnected: () => void;
  onCancel?: () => void;
};

type Method = "oauth" | "apiKey";

export function SettingsForm({ initialSpaceUrl, oauthAvailable, onConnected, onCancel }: Props) {
  const [spaceUrl, setSpaceUrl] = useState(initialSpaceUrl);
  const [method, setMethod] = useState<Method>(oauthAvailable ? "oauth" : "apiKey");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The user pressed "Stop waiting" during this attempt. */
  const stopped = useRef(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    stopped.current = false;
    try {
      if (method === "oauth") await api.signInWithOAuth(spaceUrl);
      else await api.connect(spaceUrl, apiKey);
      onConnected();
    } catch (err) {
      // Stopping the sign-in on purpose is not an error worth showing.
      if (!(stopped.current && isCommandError(err) && err.kind === "cancelled")) {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: Method) => {
    setMethod(next);
    setError(null);
  };

  const waitingForBrowser = busy && method === "oauth";

  return (
    <div className="center">
      <form className="settings" onSubmit={submit}>
        <h1>Connection</h1>
        <label>
          Space URL
          <input
            value={spaceUrl}
            onChange={(e) => setSpaceUrl(e.target.value)}
            placeholder="https://example.backlog.jp"
            autoFocus
            required
            disabled={busy}
          />
        </label>
        {method === "apiKey" && (
          <label>
            API key
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Personal settings → API"
              required
              disabled={busy}
            />
          </label>
        )}
        <p className="muted small">
          {waitingForBrowser
            ? "Allow access in the browser window that opened, then come back here."
            : method === "oauth"
              ? "Opens Backlog in your browser to allow access. The sign-in is stored in the macOS Keychain."
              : "The API key is stored in the macOS Keychain."}{" "}
          Changing the space clears the local cache.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          {oauthAvailable && !busy && (
            <button
              type="button"
              className="link settings-switch"
              onClick={() => switchTo(method === "oauth" ? "apiKey" : "oauth")}
            >
              {method === "oauth" ? "Use an API key instead" : "Sign in with Backlog instead"}
            </button>
          )}
          {waitingForBrowser ? (
            <button
              type="button"
              onClick={() => {
                stopped.current = true;
                void api.cancelSignIn();
              }}
            >
              Stop waiting
            </button>
          ) : (
            onCancel && (
              <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
            )
          )}
          <button type="submit" className="primary" disabled={busy}>
            {method === "oauth"
              ? waitingForBrowser
                ? "Waiting for the browser…"
                : "Sign in with Backlog"
              : busy
                ? "Connecting…"
                : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}
