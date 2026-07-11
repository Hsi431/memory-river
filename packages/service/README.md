# @memory-river/service

Loopback HTTP daemon for Memory River. The CLI is `mr-serve`.

`mr-serve` uses the same engine bootstrap as `@memory-river/adapter-mcp`:
`MEMORY_RIVER_DATA_DIR`/`DATA_DIR`, `MEMORY_RIVER_RAM_DIR`/`RAM_DIR`,
`MEMORY_RIVER_OLLAMA_URL`/`OLLAMA_URL`/`OLLAMA_BASE_URL`, and
`MEMORY_RIVER_EMBEDDING_MODEL`/`OLLAMA_EMBEDDING_MODEL` are read by the shared
adapter config.

The service only binds `127.0.0.1`. `MR_SERVE_PORT` selects the port and
defaults to `4791`.

## Endpoints

- `GET /health`
- `POST /recall` with `{ "query": "...", "limit": 5 }`
- `POST /store` with `{ "text": "...", "category": "fact", "importance": 0.8 }`
- `POST /rehydrate` with `{ "entryIds": [1, 2], "limit": 10 }`
- `POST /archive-transcript` with `{ "session": { "sessionKey": "..." }, "messages": [...] }`

## Security Note

v1 has no authentication because it listens on loopback only. Before publishing
or enabling non-loopback access, add token authentication.

## systemd --user Example

This is only an example unit. Do not install it unless you intend to manage the
daemon with systemd.

```ini
[Unit]
Description=Memory River local HTTP service

[Service]
Type=simple
Environment=MEMORY_RIVER_DATA_DIR=%h/.memory-river
Environment=MR_SERVE_PORT=4791
ExecStart=%h/.npm-global/bin/mr-serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```
