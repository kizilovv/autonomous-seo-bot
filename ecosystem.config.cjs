// pm2 config example.
// Two roles share one repo:
//   - api: Fastify read-only HTTP server (port 9100, localhost-only by default)
//   - mcp: stdio MCP server is launched on demand by clients (Claude Code, Cursor, etc.),
//          NOT as a long-running pm2 process. See README.md.

module.exports = {
  apps: [
    {
      name: "autonomous-seo-bot",
      cwd: process.env.SEO_BOT_HOME || ".",
      script: "dist/src/index.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "500M",
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: "30s",
      kill_timeout: 8000,
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        // All real config goes in `.env` next to the binary; see .env.example.
      },
      time: true,
    },
  ],
};
