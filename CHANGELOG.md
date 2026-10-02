# Changelog

## 3.0.0 — next public release

### Durable Agent Mode

- Added provider-neutral durable tasks for autonomous and multi-agent coding.
- Added idempotent task submission, priorities, dependency DAGs, and exclusive worktree/resource leases.
- Added cross-process journal locking so separate MCP hosts cannot claim the same lease concurrently.
- Added lease heartbeats, expiry, dead-owner recovery, interruption reconciliation, and durable event history.
- Added real verification command gates and bounded evidence-backed repair loops.
- Added optional independent logical verifier policy.
- Added per-task cross-process verification locks to prevent duplicate gate execution.
- Raw verification stdout/stderr remains ephemeral and is not persisted automatically.
- Added strict payload bounds for durable contracts/evidence.

### MCP/runtime

- Migrated lifecycle to the current high-level `McpServer` API while retaining the existing JSON Schema catalog through the documented advanced low-level handler surface.
- Removed deprecated HTTP+SSE transport; HTTP now uses current MCP Streamable HTTP only.
- Preserved stdio as the simplest local transport.
- Kept personal HTTPS fully user-owned; no shared relay or shared project credential was introduced.

### Quality

- Added cross-process ownership tests, verifier-concurrency tests, restart recovery tests, repair-loop tests, payload-bound tests, and packaged-agent E2E verification.
- Added Windows GitHub Actions CI, security guidance, and architecture documentation.
- Privacy gate continues to reject common secrets, email addresses, absolute Windows paths, and user-home paths.
