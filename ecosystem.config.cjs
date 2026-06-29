// pm2 config for csboard-seo-bot on Koara (95.217.106.61).
// Two app-roles share one process tree:
//   - api: Fastify read-only HTTP server (port 9100, localhost-only)
//   - mcp: stdio MCP server is launched on demand by clients (Claude Code, etc.),
//          NOT as a long-running pm2 process. See README.md.

module.exports = {
  apps: [
    {
      name: "csboard-seo-bot",
      cwd: "/srv/csboard-seo",
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
        DB_PATH: "/srv/csboard-seo/data/seo.db",
        HTTP_PORT: "9100",
        // 0.0.0.0 so the prod frontend container (bridge network) can reach
        // us via host.docker.internal:9100. Loopback (127.0.0.1) blocked it.
        HTTP_HOST: "0.0.0.0",
        ALLOWED_ORIGINS: "https://csboard.com,https://csboard.trade,https://www.csboard.com,https://www.csboard.trade",
      },
      output: "/var/log/csboard-seo/out.log",
      error: "/var/log/csboard-seo/err.log",
      time: true,
    },
  ],
};
