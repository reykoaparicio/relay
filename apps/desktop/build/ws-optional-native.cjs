// Stand-in for `ws`'s optional native add-ons (`bufferutil`, `utf-8-validate`), which Relay does not install.
// electron.vite.config.ts aliases both ids here AND defines WS_NO_BUFFER_UTIL / WS_NO_UTF_8_VALIDATE, so `ws`
// never calls into this module; it exists only so Vite does not inject its dev-mode stub, which throws when the
// bundle loads and killed the runner on every `pnpm dev` start.
module.exports = {};
