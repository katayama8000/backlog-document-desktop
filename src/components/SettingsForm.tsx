import { type FormEvent, useRef, useState } from "react";
import { api, errorMessage, isCommandError } from "../api";
import { Icon } from "./Icon";

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

  const primaryLabel =
    method === "oauth"
      ? waitingForBrowser
        ? "Waiting for the browser…"
        : "Sign in with Backlog"
      : busy
        ? "Connecting…"
        : "Connect";

  return (
    <div className="center">
      <form className="settings" onSubmit={submit}>
        <div className="settings-header">
          <h1>Connection</h1>
          {onCancel && !busy && (
            <button type="button" className="link" onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
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
        {error && <p className="error">{error}</p>}
        <div className="settings-actions">
          <button type="submit" className="primary wide" disabled={busy}>
            {busy && <Icon name="reload" className="spin" />}
            {primaryLabel}
          </button>
          <p className="muted small">
            {waitingForBrowser
              ? "Allow access in the browser window that opened, then come back here."
              : method === "oauth"
                ? "Opens Backlog in your browser. The sign-in is kept in the macOS Keychain."
                : "The API key is kept in the macOS Keychain."}{" "}
            {!waitingForBrowser && "Changing the space clears the local cache."}
          </p>
          {waitingForBrowser && (
            <button
              type="button"
              className="link"
              onClick={() => {
                stopped.current = true;
                void api.cancelSignIn();
              }}
            >
              Stop waiting
            </button>
          )}
        </div>
        {oauthAvailable && !busy && (
          <>
            <div className="settings-divider" role="separator">
              or
            </div>
            <button
              type="button"
              className="link settings-switch"
              onClick={() => switchTo(method === "oauth" ? "apiKey" : "oauth")}
            >
              {method === "oauth" ? "Use an API key instead" : "Sign in with Backlog instead"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
