// MCP server — write interface for agents.
// Runs over stdio. Connect from any MCP client (Claude Code, Cursor, etc.) via:
//   node dist/src/mcp/server.js
//
// All write operations go through here. The HTTP API has zero write surface.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runMigrations } from "../db/migrate.js";
import {
  upsertContent,
  deleteContent,
  rollbackContent,
  upsertSitemapExtra,
  getPageContent,
  listPages,
  getContentHistory,
} from "../db/repo.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

const TOOLS = [
  {
    name: "seo.list_pages",
    description: "List every (locale, path) tuple that has at least one SEO content field.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "seo.get_content",
    description:
      "Return the full SEO content for a (locale, path). Returns title, description, h1, intro, faq, keywords, etc. Empty object if nothing set yet.",
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
        path: { type: "string", description: "Route path, e.g. /pricing or /items/foo" },
      },
      required: ["locale", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "seo.update_content",
    description:
      "Create or replace one SEO field for a page. Examples of `field`: title, description, h1, intro, faq, keywords, intro_extra. `value` must match the field shape: string for title/description/h1/intro/intro_extra, array of {q,a} for faq, array of strings for keywords.",
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
        path: { type: "string" },
        field: {
          type: "string",
          enum: ["title", "description", "h1", "intro", "faq", "keywords", "intro_extra"],
        },
        value: {
          description:
            "string for title/description/h1/intro/intro_extra, array of {q,a} objects for faq, array of strings for keywords",
        },
        reason: { type: "string", description: "Why this change (used in audit log)" },
        source: {
          type: "string",
          description: "Identity of the writer, e.g. 'agent:rank-pusher' or 'manual:human'",
          default: "agent:unknown",
        },
      },
      required: ["locale", "path", "field", "value", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "seo.delete_content",
    description: "Soft-delete a content row (sets active = 0). Frontend will fall back to bundled i18n.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "seo.rollback",
    description: "Restore the value of a content row from a specific history entry.",
    inputSchema: {
      type: "object",
      properties: {
        history_id: { type: "number" },
      },
      required: ["history_id"],
      additionalProperties: false,
    },
  },
  {
    name: "seo.history",
    description: "List the change history for a (locale, path).",
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
        path: { type: "string" },
        limit: { type: "number", default: 50 },
      },
      required: ["locale", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "seo.set_sitemap_priority",
    description: "Set or clear sitemap priority/changefreq/lastmod for a path.",
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
        path: { type: "string" },
        priority: { type: "number", minimum: 0, maximum: 1, nullable: true },
        changefreq: {
          type: "string",
          enum: ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"],
          nullable: true,
        },
        lastmod: { type: "string", description: "ISO8601 timestamp", nullable: true },
      },
      required: ["locale", "path"],
      additionalProperties: false,
    },
  },
] as const;

function asJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export async function startMcpServer() {
  runMigrations();

  const server = new Server(
    { name: config.SERVICE_NAME, version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    logger.info({ tool: name, args }, "mcp tool call");

    try {
      switch (name) {
        case "seo.list_pages":
          return asJson(listPages());

        case "seo.get_content": {
          const { locale, path } = args as { locale: string; path: string };
          return asJson(getPageContent(locale, path));
        }

        case "seo.update_content": {
          const a = args as {
            locale: string;
            path: string;
            field: string;
            value: unknown;
            reason: string;
            source?: string;
          };
          const result = upsertContent({
            locale: a.locale,
            path: a.path,
            field: a.field,
            value: a.value,
            source: a.source ?? "agent:unknown",
            reason: a.reason,
          });
          return asJson({ ok: true, ...result });
        }

        case "seo.delete_content": {
          const { id } = args as { id: number };
          return asJson(deleteContent(id));
        }

        case "seo.rollback": {
          const { history_id } = args as { history_id: number };
          return asJson(rollbackContent(history_id));
        }

        case "seo.history": {
          const { locale, path, limit } = args as { locale: string; path: string; limit?: number };
          return asJson(getContentHistory(locale, path, limit ?? 50));
        }

        case "seo.set_sitemap_priority": {
          const a = args as {
            locale: string;
            path: string;
            priority?: number | null;
            changefreq?: string | null;
            lastmod?: string | null;
          };
          upsertSitemapExtra({
            locale: a.locale,
            path: a.path,
            priority: a.priority ?? null,
            changefreq: a.changefreq ?? null,
            lastmod: a.lastmod ?? null,
          });
          return asJson({ ok: true });
        }

        default:
          return asJson({ error: `unknown tool ${name}` });
      }
    } catch (e) {
      logger.error({ tool: name, error: (e as Error).message }, "mcp tool failed");
      return asJson({ error: (e as Error).message });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp server ready (stdio)");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((e) => {
    logger.error({ error: (e as Error).message }, "mcp fatal");
    process.exit(1);
  });
}
