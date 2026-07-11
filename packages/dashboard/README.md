# Memory River Dashboard

`@memory-river/dashboard` provides read-only CLI reports and a local web UI for a
Memory River LanceDB database.

## Web UI

Build the workspace, then start the dashboard:

```sh
npm run build
mr-dash serve --db /path/to/lancedb
mr-dash serve --db /path/to/lancedb --port 8080
```

The default port is `7777`. The server binds only to `127.0.0.1` and prints its
local URL after it starts. It exposes no write or delete endpoints.

## JSON API

- `GET /api/tables` lists tables and row counts.
- `GET /api/effectiveness?since=24h&subsystem=a,b` summarizes subsystem effectiveness.
- `GET /api/night?since=7d` summarizes NightConsolidator runs.
- `GET /api/memories?limit=50&offset=0&category=&status=&q=` pages and filters memories.
- `GET /api/graph?limit=50&offset=0&q=` pages graph triples and searches subjects or objects.
- `GET /api/slots?limit=50&offset=0` pages memories with a non-empty `slotKey`.

The browser UI at `/` provides tabs, filters, refresh controls, and pagination
for these read-only endpoints.

## Export

Export all non-trashed, non-deprecated, and non-superseded memories to one
Markdown file:

```sh
mr-dash export --db /path/to/lancedb --out ./exports/memories.md
```

The command creates missing parent directories and orders memories by
`updatedAt` descending, then `id` ascending. Each memory is written as an H2
section with YAML metadata followed by its text:

````markdown
## memory-123

```yaml
id: "memory-123"
category: "fact"
status: "active"
importance: 0.8
healthScore: 95
updatedAt: "2026-06-15T10:00:00.000Z"
```

The memory text appears here.
````
