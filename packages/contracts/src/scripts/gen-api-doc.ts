// Build-time script: prints the IPC API reference to stdout (`pnpm gen:api-doc` writes docs/architecture/ipc-api.md).
import { OPERATION_LIST } from '../ipc/catalog.js';
import { renderApiDoc } from './render-api-doc.js';

// A closed pipe (e.g. `| head`) is not an error for a docs printer.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});
process.stdout.write(renderApiDoc(OPERATION_LIST));
