# Architecture

## Layers

```text
MCP host / model
      |
      | stdio or authenticated HTTP
      v
Free Coding Agent
      |
      +-- durable task kernel
      +-- filesystem + transactional patches
      +-- shell / jobs / PTY
      +-- Git
      +-- LSP
      +-- browser / Chrome
      +-- Windows / VS Code
      |
      v
allowed local workspaces
```

## Durable Agent Mode

The task kernel is model/provider neutral. It coordinates external workers through durable contracts rather than invoking a hardcoded model.

State machine:

```text
queued ----claim----> running ----ready----> verifying ----pass----> succeeded
                         |                      |
                         |                      +----fail----> repairing
                         |                                      |
                         +----fail----> failed                  +----claim----> running
                         |
                         +----lease loss/restart----> interrupted
                                                     |
                                                     +--> requeue
                                                     +--> recover running
                                                     +--> failed
```

Key invariants:

1. A task is successful only after verification.
2. `leaseKey` reserves a worktree/resource across running and verifying states.
3. Cross-process journal locking serializes task mutations from multiple MCP processes.
4. Worker leases expire and dead owner processes recover to `interrupted`.
5. Verification has its own per-task cross-process lock.
6. Task dependencies must succeed before dependents can run.
7. Verification failures produce bounded repair loops.
8. Raw verification stdout/stderr is ephemeral unless a client explicitly chooses to persist it elsewhere.
9. Tasks may require a logical verifier identity different from implementation worker identities.
10. Runtime task data lives outside the source tree by default and is excluded from publication.

## Remote access

There is no project-operated relay. Remote mode exposes the user's loopback MCP server through infrastructure owned by that user (recommended: personal Tailscale Funnel; optional: personal Cloudflare Tunnel).
