// Electron main entry (08 H1). All logic lives in boot.ts (tested) and compose-main.ts (Electron wiring). Boot failures
// (including an unwritable data folder) end in a native error box and exit(1), never a silent exit.
import { app, dialog } from 'electron';
import { startApp } from './boot.js';
import { createProductionServices } from './compose-main.js';
import { checkDirWritable } from './userdata-check.js';

void startApp({
  app,
  env: process.env,
  createServices: createProductionServices,
  onSignal: (signal, handler) => {
    process.on(signal, handler);
  },
  checkWritable: (dir) => checkDirWritable(dir),
  showErrorBox: (title, content) => {
    dialog.showErrorBox(title, content);
  },
});
