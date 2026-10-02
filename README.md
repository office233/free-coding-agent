# Free Coding Agent

**Give frontier AI models real hands on a real developer workstation.**

Free Coding Agent is an open-source, provider-neutral MCP execution layer that turns a capable model from a chat box into a hands-on software engineer. The model supplies the intelligence; Free Coding Agent supplies controlled access to files, terminals, Git, language servers, browsers, Windows UI, jobs, checkpoints, tests, and diagnostics.

LM Arena describes Code Arena as a place to build and compare with frontier AI models. Free Coding Agent is designed to be a compatible execution layer for any host that supports MCP or equivalent remote tools. It is independent software and is not an LM Arena product.

## Core principle: no shared project infrastructure

Free Coding Agent does **not** require a relay, domain, account, API key, tunnel, or backend operated by this project.

Every installation is independent:

- its own local configuration;
- its own workspace allowlist;
- its own MCP bearer token;
- its own HTTP server;
- its own HTTPS hostname/tunnel when remote access is enabled;
- its own third-party account, if the user chooses a tunneling provider.

There is no common Free Coding Agent relay and no common remote credential.

## What it can do

- transactional filesystem reads/writes;
- atomic multi-file patches and rollback checkpoints;
- optimistic SHA-256 concurrency protection;
- shell commands and long-running processes;
- real PTY / ConPTY for REPLs, debuggers, SSH and TUIs;
- Git status, diff, history and repository operations;
- headless LSP diagnostics, definitions, references, hover and symbols;
- project inspection and project-local memory;
- Playwright browser automation;
- optional real-Chrome companion extension;
- optional VS Code companion extension;
- Windows UI automation;
- FFmpeg/media workflows;
- resource admission to avoid CPU/RAM stampedes;
- MCP batching and capability discovery;
- local stdio MCP;
- authenticated local HTTP MCP;
- optional personal public HTTPS MCP.

## Install on Windows

The normal installation flow is:

```text
Download ZIP
→ extract
→ double-click install.cmd
→ choose the folder the agent may access
→ optionally configure YOUR personal HTTPS endpoint
→ Ready
```

The installer:

1. verifies Node.js 20+;
2. can install Node.js LTS when Windows Package Manager is available;
3. installs `free-coding-agent` globally;
4. configures the user's own workspace;
5. runs `free-coding-agent doctor`;
6. optionally guides the user through personal HTTPS setup.

The extracted installer folder can be deleted afterwards.

## Local mode — no domain, no internet tunnel

For an MCP client running on the same machine, nothing public is needed:

```json
{
  "mcpServers": {
    "free-coding-agent": {
      "command": "free-coding-agent",
      "args": ["stdio"]
    }
  }
}
```

No domain. No TLS. No exposed port. No external service.

## Personal HTTPS mode

When the model host is remote/cloud-based, it needs a public HTTPS URL that reaches the user's machine.

Free Coding Agent's official remote model is **personal self-configuration**, not a shared relay.

### Recommended: Tailscale Funnel

Run:

```powershell
free-coding-agent remote setup
```

The setup uses the current user's own Tailscale account.

Tailscale Funnel gives that machine its own stable HTTPS hostname under the user's tailnet:

```text
https://<device>.<tailnet>.ts.net/mcp
```

Free Coding Agent then:

- generates a strong MCP bearer token locally;
- keeps the HTTP origin bound to `127.0.0.1`;
- exposes it only through that user's Funnel;
- stores the URL/token only in that user's application-data directory;
- adds a current-user startup entry for the local HTTP server;
- prints the exact MCP configuration.

Example output shape:

```json
{
  "mcpServers": {
    "free-coding-agent": {
      "url": "https://YOUR-PERSONAL-HOST.ts.net/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_LOCAL_TOKEN"
      }
    }
  }
}
```

Tailscale documents Funnel hostnames as predictable/stable, automatically TLS-protected, and publicly reachable while the user's machine is online.

### Alternative: personal Cloudflare Tunnel

Users who own a domain on Cloudflare can use a locally managed named Cloudflare Tunnel instead.

The ownership model remains the same:

```text
their Cloudflare account
+ their domain
+ their tunnel
+ their DNS record
+ their local MCP token
```

Cloudflare's documented flow is:

```text
cloudflared tunnel login
cloudflared tunnel create <name>
cloudflared tunnel route dns <name-or-id> <hostname>
cloudflared tunnel run <name-or-id>
```

A named tunnel can also be installed as an OS service. Free Coding Agent does not own or operate it.

## Why personal HTTPS instead of a project relay?

Because the open-source project should keep working independently of its author.

With personal endpoints:

- no project-operated server can go offline and break everybody;
- no project operator sees MCP traffic;
- no shared credential exists;
- no shared customer/device database exists;
- no central billing requirement exists;
- users can replace Tailscale/Cloudflare with another provider;
- users can self-host everything indefinitely.

## CLI

```text
free-coding-agent
free-coding-agent stdio
free-coding-agent setup
free-coding-agent remote setup
free-coding-agent remote start
free-coding-agent remote status
free-coding-agent remote off
free-coding-agent doctor
free-coding-agent print-config
```

## npm

The package is structured for public npm installation:

```powershell
npm install -g free-coding-agent
free-coding-agent setup
```

The npm package must exist in the registry before those commands can be used from npm directly.

## Security model

The agent can modify files and execute code, so remote exposure must fail closed.

The personal HTTPS setup enforces:

- a random local `MCP_API_KEY`;
- bearer authentication for every remote MCP request;
- loopback-only local HTTP binding;
- filesystem allowlisting via `FCA_ALLOWED_ROOTS`;
- no anonymous proxy access;
- no secret committed to Git;
- no project-wide tunnel or account;
- no remote credentials shared between users.

A remote URL without the user's bearer token cannot use the agent.

## User configuration

Normal users should use the CLI instead of editing config manually.

Important variables:

| Variable | Purpose |
| --- | --- |
| `FCA_WORKSPACES` | User's known workspaces |
| `FCA_DEFAULT_WORKSPACE` | Default workspace |
| `FCA_ALLOWED_ROOTS` | Filesystem sandbox |
| `FCA_REMOTE_PROVIDER` | Personal remote provider |
| `FCA_REMOTE_URL` | User's personal public MCP URL |
| `FCA_TAILSCALE_DNS_NAME` | User's personal Tailscale DNS name |
| `MCP_API_KEY` | User's own HTTP bearer token |
| `MCP_HOST` | Local HTTP bind address |
| `PORT` | Local HTTP port |
| `FCA_CHROME_BRIDGE_ENABLED` | Enable real-Chrome integration |
| `CHROME_BRIDGE_TOKEN` | Local Chrome pairing secret |
| `CHROME_EXTENSION_ID` | Optional extension identity pin |
| `VSCODE_BRIDGE_URL` | Local VS Code companion endpoint |

Configuration and runtime state live in standard per-user application-data directories, outside the repository.

## OpenCode

OpenCode supports both local and remote MCP servers. A personal Free Coding Agent HTTPS endpoint can be configured as a remote MCP server with bearer authentication.

Conceptually:

```json
{
  "type": "remote",
  "url": "https://YOUR-PERSONAL-HOST/mcp",
  "oauth": false,
  "headers": {
    "Authorization": "Bearer YOUR_LOCAL_TOKEN"
  }
}
```

Use OpenCode's current configuration schema/documentation for the surrounding config structure.

## LM Arena / frontier models

Arena's public documentation describes Agent Mode and Code Arena as environments for agentic coding and frontier-model comparison.

Free Coding Agent does not scrape or automate Arena's private UI/API. If Arena exposes a supported MCP or compatible remote-tool integration, the user's personal HTTPS MCP endpoint is ready for it.

This distinction is intentional: the open-source agent remains standards-based and does not depend on undocumented consumer-site behavior.

References:

- https://help.arena.ai/articles/5432423882-how-to-use-agent-mode
- https://help.arena.ai/articles/5701270322-lmarena-how-to-code-arena
- https://opencode.ai/v2/docs/mcp-servers
- https://tailscale.com/docs/features/tailscale-funnel
- https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/

## Chrome companion extension

The optional extension gives the local MCP server controlled access to the user's real Chrome.

1. Load `chrome-extension` as an unpacked extension.
2. Configure a local `CHROME_BRIDGE_TOKEN`.
3. Enter the same token in the extension popup.
4. Optionally pin the assigned extension ID.

No fixed extension identity key is stored in this repository.

## VS Code companion extension

The optional extension exposes loopback-only editor state:

- diagnostics;
- references;
- definitions;
- open files;
- debugger state.

Configuration key:

```text
freeCodingAgent.port
```

Default port: `3005`.

## Development

```powershell
npm install
npm run check
npm run privacy
npm run preflight
npm test
```

## Privacy / publication hygiene

The public source tree intentionally excludes:

- local `.env` files;
- API keys;
- tunnel credentials;
- machine-specific paths;
- user names and email addresses;
- conversation archives;
- browser profiles;
- screenshots and clips;
- logs, checkpoints and job state;
- local memory;
- fixed Chrome extension identity keys;
- provider-account-specific orchestration.

`npm run privacy` fails if common secrets, email addresses, absolute Windows paths, or user-home paths appear in publishable source.

## License

ISC. See `LICENSE`.
