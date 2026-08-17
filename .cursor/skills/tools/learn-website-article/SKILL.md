---
name: learn-website-article
description: >-
  Learns a public website or docs page and creates or updates a Russian
  knowledge-base article via the scrapregos-knowledge MCP server
  (knowledge_search, knowledge_get, knowledge_create, knowledge_update).
  Use when the user asks to learn a site, read a URL, scrape documentation,
  or create a knowledge article from a website.
---

# Learn website → knowledge article

Read the site, then write a support-style article into the live knowledge base through MCP. Do not invent facts that are not on the page.

## MCP

Server id: `project-0-ScrapRegosUserBot-scrapregos-knowledge`

Always load the tool schema with `GetMcpTools` before the first `CallMcpTool` in the session.

| Action | Tool | Notes |
| --- | --- | --- |
| Find duplicates | `knowledge_search` | Query title keywords + product name. Empty query = recent articles. |
| Read style / existing | `knowledge_get` | Load a close match before writing. |
| Create | `knowledge_create` | `title` (max 200), `body` (max 20000), `tags` (comma-separated, max 300). |
| Refresh | `knowledge_update` | Same limits. Skip locked articles. |
| Delete | `knowledge_delete` | Only if the user asked. |

If tools are missing, call `mcp_auth` on this server, then `GetMcpTools` again. Do not print the MCP bearer token from `.cursor/mcp.json`.

## Workflow

Copy and track:

```
- [ ] Resolve URL(s)
- [ ] Search KB for duplicates
- [ ] Fetch page(s)
- [ ] Draft article
- [ ] Create or update via MCP
- [ ] Report id, title, tags, source URL
```

### 1. Resolve sources

Use the URL the user gave. If they named a product without a URL, search the public web, then fetch the official page (prefer `docs.regos.uz`, `easytrade.uz`, `rofeev.uz`, `regos.uz`).

### 2. Deduplicate

Call `knowledge_search` with the page topic and product name (limit 10).

- Close match and user asked to learn/create → load it with `knowledge_get`. If the page has new facts, `knowledge_update`; otherwise tell the user the existing id and stop.
- No match → create.
- User said "update article N" → `knowledge_get` then `knowledge_update`.

### 3. Learn the site

Fetch with `WebFetch`. If the page is a hub (docs index, TOC, feature list), fetch the 2–5 most relevant child pages. Stay on the same official host. Read-only: do not log in or change portal data.

If `WebFetch` is thin or blocked, try `WebSearch` for the same title, then fetch the official result. Quote only what you actually read.

### 4. Write the article

Language: **Russian**, same register as existing KB articles (short factual paragraphs for support staff).

Structure:

1. First sentence: what it is. Include the canonical source URL in the first paragraph.
2. Who it is for / when to use it (only if the page says so).
3. Concrete facts: modules, steps, contacts, limits. Use lists or semicolon-separated features.
4. Related official links if they were on the page.

Rules:

- Support facts only; no marketing filler, no prices unless the page states them.
- Do not copy legal pages or long tables verbatim.
- Title ≤ 200 chars, specific (`EasyTrade — программа автоматизации торговли`, not `Обзор`).
- Body ≤ 20000 chars; prefer 800–4000 for one topic. Split huge docs into several articles.
- Tags: lowercase, comma-separated, 3–8 items (`easytrade, продукт, сайт`).

### 5. Save

`CallMcpTool` → `knowledge_create` or `knowledge_update`. Then report:

- article **id**
- **title** and **tags**
- source URL(s)
- created vs updated

## Examples

**Create from a site**

User: "Learn https://easytrade.uz/ and create an article."

1. `knowledge_search` query `EasyTrade`
2. `WebFetch` the URL (and a features/docs child page if needed)
3. `knowledge_create` with a Russian summary and tags `easytrade, продукт, сайт`

**Refresh existing**

User: "Update the Store Management article from https://docs.regos.uz/en/regos-sm/operations"

1. `knowledge_search` query `Store Management`
2. `knowledge_get` the matching id
3. Fetch the docs page
4. `knowledge_update` that id (omit unchanged fields)
