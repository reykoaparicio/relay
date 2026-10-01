// 08 H2: the preload entry. Bundled as one sandbox-safe CJS file (@relay/contracts and zod are inlined); exposes only
// the allowlisted bridge from bridge.ts as `window.relay`.
import { contextBridge, ipcRenderer } from 'electron';
import { createRelayApi } from './bridge.js';

contextBridge.exposeInMainWorld('relay', createRelayApi(ipcRenderer, process.platform));

export type { RelayBridge } from './bridge.js';
