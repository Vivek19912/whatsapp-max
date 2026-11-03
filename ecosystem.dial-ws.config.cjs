// PM2 process file for the CallVault click-to-dial WebSocket sidecar.
//
// Production: copy to the app root on the server and run:
//   pm2 start ecosystem.dial-ws.config.cjs
//   pm2 save
//
// The sidecar reads its own environment from the deployed .env.local
// (--env-file), so no secrets live in this file. Requires
// DIAL_WS_INTERNAL_SECRET (and the Supabase vars) to be present in
// that .env file. See docs/dial-websocket.md.
module.exports = {
  apps: [
    {
      name: 'wacrm-dial-ws',
      script: './scripts/dial-ws-server.mjs',
      node_args: '--env-file=./.env.local',
    },
  ],
};
