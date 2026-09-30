// Electron main entry (08 H1). All logic lives in boot.ts (tested) and compose-main.ts (Electron wiring).
import { app } from 'electron';
import { boot } from './boot.js';
import { createProductionServices } from './compose-main.js';

void boot({ app, env: process.env, createServices: createProductionServices });
