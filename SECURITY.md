# Security

Free Coding Agent can read and modify files, execute processes, drive browsers, and automate the local workstation. Treat MCP access as developer-shell access.

## Safe defaults

- Local HTTP binds to `127.0.0.1`.
- Remote HTTP requires a locally generated bearer token.
- Personal HTTPS is owned/configured by each user; the project operates no shared relay.
- `FCA_ALLOWED_ROOTS` is the hard filesystem boundary.
- Runtime state, credentials, logs, browser profiles, checkpoints, tasks, screenshots, and clips are ignored by Git.
- Durable task verification never persists raw command stdout/stderr automatically.

## Reporting a vulnerability

Do not put secrets, live credentials, private source code, or exploit payloads containing user data into a public issue. Use GitHub's private vulnerability reporting feature when it is enabled for the repository.

## Threat model

The project assumes the MCP client/model is authorized to perform developer work inside the configured roots. The security boundary is intended to protect unrelated filesystem locations and prevent unauthenticated remote access; it is not a sandbox for hostile code executed intentionally by an authorized agent.
