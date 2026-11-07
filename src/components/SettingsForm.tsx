import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api";

type Props = {
  initialSpaceUrl: string;
  onConnected: () => void;
  onCancel?: () => void;
};

export function SettingsForm({ initialSpaceUrl, onConnected, onCancel }: Props) {
  const [spaceUrl, setSpaceUrl] = useState(initialSpaceUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connect(spaceUrl, apiKey);
      onConnected();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

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
          />
        </label>
        <label>
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Personal settings → API"
            required
          />
        </label>
        <p className="muted small">
          The API key is stored in the macOS Keychain. Changing the space
          clears the local cache.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          {onCancel && (
            <button type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </div>
  );
}
