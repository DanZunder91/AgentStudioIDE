/** Drives the same apiActions as the API client's env editor: one store, two surfaces. Values
 * persist only via the Rust store in the app-data dir, never a repo file. Hydrates once on mount
 * (the ApiRequestView guard); the store flag, not a module latch, lets resetStore re-arm it. */

import { useEffect, useState } from "react";

import { useAppStore } from "../../app/store";
import { loadApiStore, type Environment } from "./apiStoreIpc";
import "./api.css";
import "./vault.css";

export function VaultPanel(): React.JSX.Element {
  const environments = useAppStore((s) => s.apiEnvironments);
  const addEnvironment = useAppStore((s) => s.apiActions.addEnvironment);
  const hydrateApiStore = useAppStore((s) => s.apiActions.hydrateApiStore);

  useEffect(() => {
    if (useAppStore.getState().apiStoreLoaded) return;
    let cancelled = false;
    void loadApiStore().then((store) => {
      if (!cancelled) hydrateApiStore(store);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrateApiStore]);

  return (
    <div className="vault-panel" data-testid="vault-panel">
      <div className="vault-panel__head">
        <p className="vault-panel__note">
          Environments hold secrets like API tokens. They are stored securely in the
          app data dir — never in the repo.
        </p>
        <button
          type="button"
          className="api-add-header"
          data-testid="vault-add-env"
          onClick={() => addEnvironment("New environment")}
        >
          + Add environment
        </button>
      </div>

      {environments.length === 0 ? (
        <div className="api-section__empty">No environments</div>
      ) : (
        <div className="vault-panel__envs">
          {environments.map((env) => (
            <VaultEnv key={env.id} env={env} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Variables are keyed by `key` (the wire model): editing a key is delete-then-add. Mirrors the API
 * client's inline EnvEditor so the two surfaces feel identical. */
function VaultEnv({ env }: { env: Environment }): React.JSX.Element {
  const renameEnvironment = useAppStore((s) => s.apiActions.renameEnvironment);
  const deleteEnvironment = useAppStore((s) => s.apiActions.deleteEnvironment);
  const setEnvVar = useAppStore((s) => s.apiActions.setEnvVar);
  const removeEnvVar = useAppStore((s) => s.apiActions.removeEnvVar);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const addKey = newKey.trim();
  // The "+ Add" button is disabled while `addKey` is empty, so this only runs
  // with a real key.
  const addVar = () => {
    setEnvVar(env.id, addKey, newValue);
    setNewKey("");
    setNewValue("");
  };

  return (
    <div className="api-env" data-testid="vault-env">
      <div className="api-env__head">
        <input
          type="text"
          className="api-header-row__name"
          aria-label="Environment name"
          value={env.name}
          onChange={(e) => renameEnvironment(env.id, e.target.value)}
        />
        <button
          type="button"
          className="api-header-row__remove"
          aria-label={`Delete environment ${env.name}`}
          title="Delete environment"
          onClick={() => deleteEnvironment(env.id)}
        >
          ✕
        </button>
      </div>
      {env.variables.map((v) => (
        <div className="api-header-row" data-testid="vault-env-var" key={v.key}>
          <span className="api-env-var__key">{v.key}</span>
          <input
            type="text"
            className="api-header-row__value"
            aria-label={`Value of ${v.key}`}
            value={v.value}
            onChange={(e) => setEnvVar(env.id, v.key, e.target.value)}
          />
          <button
            type="button"
            className="api-header-row__remove"
            aria-label={`Remove ${v.key}`}
            title="Remove variable"
            onClick={() => removeEnvVar(env.id, v.key)}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="api-header-row">
        <input
          type="text"
          className="api-header-row__name"
          aria-label="New variable key"
          placeholder="KEY"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <input
          type="text"
          className="api-header-row__value"
          aria-label="New variable value"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button
          type="button"
          className="api-add-header"
          aria-label="Add variable"
          disabled={addKey === ""}
          onClick={addVar}
        >
          + Add
        </button>
      </div>
    </div>
  );
}
