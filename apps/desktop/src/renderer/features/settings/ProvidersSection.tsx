import { useId } from 'react';
import { appError } from '@relay/contracts';
import type { CapabilityWarning, ProfileWithWarnings } from '@relay/contracts';
import { CatalogTable, ErrorView, InlineAlert, Skeleton } from '../../components/ui';
import { toViewError } from '../../api/errors';
import { useCatalog } from '../../hooks/useCatalog';
import { useDiagnostics } from '../../hooks/useDiagnostics';
import { NOW_IDLE_INTERVAL_MS, useNow } from '../../hooks/useNow';
import { useProfiles } from '../../hooks/useProfiles';
import { useProviders } from '../../hooks/useProviders';
import { useNextAction } from '../common/useNextAction';
import { ProviderCard, providerState } from './ProviderCard';

/** CatalogTable.profileChecks: engine warnings grouped by the profile's model (06 F14); never re-derived here. */
export function profileChecksByModel(
  rows: readonly ProfileWithWarnings[],
): Record<string, CapabilityWarning[]> {
  const out: Record<string, CapabilityWarning[]> = {};
  for (const { profile, warnings } of rows)
    out[profile.modelId] = [...(out[profile.modelId] ?? []), ...warnings];
  return out;
}

/** Settings → Providers (mock settings-providers: connected / no-secure-storage / auth-failed) + Models. */
export function ProvidersSection() {
  const providersTitle = useId();
  const modelsTitle = useId();
  const providers = useProviders();
  const diagnostics = useDiagnostics();
  const catalog = useCatalog();
  const profiles = useProfiles();
  const providersAction = useNextAction({ reload: () => void providers.refetch(), wait: () => void providers.refetch() });
  const catalogAction = useNextAction({ reload: () => void catalog.refetch(), wait: () => void catalog.refetch() });
  const profilesAction = useNextAction({ reload: () => void profiles.refetch(), wait: () => void profiles.refetch() });
  const now = useNow(NOW_IDLE_INTERVAL_MS, providers.dataUpdatedAt);
  const listed = (providers.data ?? []).filter((p) => p.providerId !== 'fake');
  const secure = diagnostics.data?.secureStorage.available ?? true;
  const rejected = listed.filter((p) => providerState(p) === 'auth-failed');
  const testFailed = listed.filter((p) => providerState(p) === 'test-failed');
  const catalogVersion =
    diagnostics.data?.catalog.version ??
    [...(catalog.data ?? [])]
      .map((c) => c.catalogVersion)
      .sort()
      .at(-1) ??
    'unknown';

  return (
    <div className="stack">
      {diagnostics.data !== undefined && !secure ? (
        <InlineAlert tone="warning" title="OS credential protection is unavailable">
          <p>
            Relay could not use the macOS Keychain through Electron safeStorage. Relay never writes API keys
            to disk in plaintext, so keys cannot be saved right now.
          </p>
          <p>
            You can use a <strong>session-only key</strong>: it stays in the privileged main process memory,
            is never shown to the interface, and is cleared when Relay quits.
          </p>
        </InlineAlert>
      ) : null}
      {rejected.map((p) => (
        <InlineAlert key={p.providerId} tone="danger" title={`${p.displayName} rejected the stored key`}>
          <p>
            The last connection test returned <code>AUTH_REQUIRED</code>: {p.displayName} rejected Relay&apos;s small
            test request made with this key. Profiles on {p.displayName} cannot start runs until you replace the
            key.
          </p>
        </InlineAlert>
      ))}
      {testFailed.map((p) => {
        const code = p.lastTest?.code;
        return (
          <InlineAlert
            key={p.providerId}
            tone="warning"
            title={`The last ${p.displayName} connection test failed`}
          >
            <p>
              {code === undefined ? 'The test did not pass.' : appError(code).userMessage}
              {code === undefined ? null : (
                <>
                  {' '}
                  Error code <code>{code}</code>.
                </>
              )}
            </p>
            <p>The stored key was not reported as rejected. Test the connection again when ready.</p>
          </InlineAlert>
        );
      })}
      <section className="stack" aria-labelledby={providersTitle}>
        <h2 id={providersTitle}>Providers</h2>
        <p className="small muted">
          Keys are submitted to the privileged main process and never returned to this screen. Only a redacted
          label is shown.
        </p>
        {providers.error === null ? null : (
          <ErrorView error={toViewError(providers.error)} onAction={providersAction} />
        )}
        {providers.data === undefined && providers.error === null ? (
          <div aria-busy="true">
            <Skeleton lines={6} />
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
          {listed.map((p) => (
            <ProviderCard key={p.providerId} provider={p} secureStorageAvailable={secure} now={now} />
          ))}
        </div>
      </section>
      <section className="card stack" aria-labelledby={modelsTitle}>
        <h2 id={modelsTitle}>Models</h2>
        <p className="small muted">
          Capabilities are checked before a run starts. Updated prices never rewrite estimates on earlier
          attempts. The profile check column shows the warnings Relay computed for the profiles that use each
          model.
        </p>
        {catalog.error === null ? null : (
          <ErrorView error={toViewError(catalog.error)} onAction={catalogAction} />
        )}
        {profiles.error === null ? null : (
          <ErrorView error={toViewError(profiles.error)} onAction={profilesAction} />
        )}
        {catalog.data === undefined ? (
          catalog.error === null ? (
            <div aria-busy="true">
              <Skeleton lines={4} />
            </div>
          ) : null
        ) : (
          <CatalogTable
            entries={catalog.data}
            catalogVersion={catalogVersion}
            {...(profiles.data === undefined ? {} : { profileChecks: profileChecksByModel(profiles.data) })}
          />
        )}
      </section>
    </div>
  );
}
