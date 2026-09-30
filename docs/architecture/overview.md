# Architecture overview

Source: spec §6 ([`Relay_Product_and_Engineering_Plan.md`](../../Relay_Product_and_Engineering_Plan.md)) and [plans/02 §B0](../../plans/02-contracts-api-layer.md). The IPC reference is generated into [`ipc-api.md`](ipc-api.md) by `pnpm gen:api-doc`; do not hand-edit it.

## System diagram (spec §6.2)

```mermaid
flowchart TD
    subgraph Desktop["Local desktop application"]
        UI["React interface"] --> Bridge["Typed preload bridge"]
        Bridge --> Main["Electron main process"]
        Main --> Runner["Workflow runner process"]
        Runner --> Gate["Budget and policy checks"]
        Runner --> Store["SQLite and artifact store"]
        Main --> Secrets["OS-protected credentials"]
        Gate --> Tools["Restricted project tools"]
        Gate --> Adapters["Provider adapters"]
    end
    Tools --> Project["Selected local project"]
    Adapters --> APIs["Remote model APIs"]
```

**Boundary:** Local project context leaves the machine only through configured provider calls in P0. No Relay-hosted backend is required. Local persistence does not make remote inference private or offline. The provider selection determines where selected context is processed.

## Processes and IPC (plans/02 §B0)

Relay has no HTTP server in P0 (ADR-0009). Its API is a typed, versioned IPC surface with two hops (renderer → main, main → runner). Channels are named `relay/v1/<resource>.<verb>` and return an `IpcResult` envelope (ADR-0018). The runner, a `utilityProcess`, is the sole database writer (spec §6.4).

```mermaid
sequenceDiagram
  participant R as Renderer (React)
  participant P as Preload (contextBridge)
  participant M as Main (IPC router)
  participant U as Runner (utilityProcess)
  R->>P: window.relay.invoke('relay/v1/runs.start', input)
  P->>M: ipcRenderer.invoke(channel, input)  [channel ∈ OPERATIONS allowlist]
  M->>M: senderCheck → rateLimit → zod.parse(input)
  alt main-owned op (dialogs, credentials, app info)
    M-->>P: IpcResult<C>
  else runner-owned op (all DB reads/writes)
    M->>U: RunnerRequest{id, channel, input} over MessagePort
    U->>U: engine / repos (sole DB writer §6.4)
    U-->>M: op.result{id, result: IpcResult}
    M-->>P: IpcResult<C> (output validated in dev)
  else main+runner composite (dialog / credential, then runner)
    M->>M: dialog or vault step (realpaths stay in main)
    M->>U: RunnerRequest{id, channel: INTERNAL_RUNNER_OPS channel or forwarded channel}
    U-->>M: op.result{id, result}
    M-->>P: IpcResult<C> (display paths only)
  end
  U--)M: RunnerEvent (run events, heartbeat)
  M--)P: 'relay/v1/events' push
  P--)R: subscribe(listener)
```

## Package dependency direction (spec §13.4)

```mermaid
flowchart LR
  renderer["apps/desktop renderer"] --> contracts
  preload["apps/desktop preload"] --> contracts
  main["apps/desktop main"] --> contracts
  runner["apps/desktop runner"] --> engine
  runner --> storage & providers & tools & templates
  engine --> contracts & templates
  engine -. "type-only" .-> storage & providers & tools
  storage --> contracts
  providers --> contracts
  tools --> contracts
  templates --> contracts
```

Enforced by `pnpm lint`:

- ESLint `boundaries/dependencies` restricts which element may import which (the edges above; main, preload, and renderer import only `@relay/contracts`).
- The engine may import storage, providers, and tools **only as types**; implementations are injected. Engine tests, `src/testing/**`, and the Electron-free composition root `src/runtime.ts` are the exceptions (R2-2).
- The renderer never imports Node, Electron, or provider SDKs. `node:sqlite` appears only in `@relay/storage`; `electron` never appears in `packages/*`; provider SDKs appear only in `@relay/providers` (dependency-cruiser).
- Deep imports into another package's `src/` or `dist/` are errors; import the package's public API.
