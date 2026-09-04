# OpenShell sandbox policies

Sandbox policy is **not** a Helm value and cannot be carried in a Blueprint. The
only policy-related chart value is `server.policyValidationFailureMode`
(Blueprint A). Policy *content* lives in three places:

| Layer | Set by | Scope |
|---|---|---|
| Image policy | `policy.yaml` baked into the sandbox image | that image |
| Sandbox policy | `openshell policy set <sandbox>` | one sandbox |
| Global policy | `openshell policy set --global` | every sandbox on the gateway |

The files here are ready to apply with the `openshell` CLI. Pass `-g <gateway>`
if you have more than one gateway registered, and **`--workspace <tenant>`
whenever the command names a sandbox** — sandbox lookup is workspace-scoped and
`--workspace` defaults to `default`, so without it you get `sandbox not found`.
`--global` commands are gateway-wide and take no workspace.

## Files

| File | Apply with | What it does |
|---|---|---|
| `global-baseline.yaml` | `openshell policy set --global --policy global-baseline.yaml` | Restrictive gateway-wide floor |
| `tenant-suse-ai.yaml` | `openshell policy set <sandbox> --policy tenant-suse-ai.yaml --wait` | Per-sandbox: SUSE registries, PyPI, npm, plus egress secret redaction |
| `claude-code-l7.yaml` | `openshell policy set <sandbox> --policy claude-code-l7.yaml --wait` | L7-inspected variant of the image's `claude_code` rule |

## Read this before applying the global policy

A global policy is applied **in full** to every sandbox, and while one is set
the gateway **rejects all sandbox-level policy updates**. That is the point —
it is a floor an individual sandbox cannot lower — but it also means
`openshell policy set <sandbox>` starts failing until you run
`openshell policy delete --global`. Try the per-sandbox files first.

## Useful commands

```shell
openshell policy get <sandbox> --base     # the image's policy, as shipped
openshell policy get <sandbox> --full     # effective policy, including the
                                          # generated _provider_* rules
openshell policy list <sandbox>

# host:port[:access[:protocol[:enforcement[:options]]]]
openshell policy update <sandbox> --add-endpoint 'github.com:443:read-only:rest:enforce' --dry-run
# host:port:METHOD:path_glob  (narrows an endpoint that is already open)
openshell policy update <sandbox> --add-allow 'api.github.com:443:GET:/repos/**' --dry-run

openshell policy delete --global
```

There is no `policy lint` subcommand in CLI 0.0.116. The files here were checked
by sending them with `policy set` against a non-existent sandbox, which exercises
the client-side strict parser (it rejects unknown fields) but not value-level or
semantic validation — that happens server-side against a real sandbox.

`network_policies` and `network_middlewares` are **dynamic** — they hot-reload on
a running sandbox. `filesystem_policy`, `landlock` and `process` are **static**
and need the sandbox recreated.

## Two things that are easy to get wrong

**`inference.local` needs no rule.** It is a built-in route in the sandbox
supervisor, not an ordinary destination, so it is never matched against
`network_policies`. Do not add an endpoint for it — the request would not go
through that path anyway. Only *external* inference hosts reached directly (e.g.
`api.openai.com`) need a network policy.

**Provider-credentialed endpoints must be inspectable.** An endpoint that
carries injected provider credentials is rejected at validation if it is
L4-only (no `protocol:`) or uses `tls: skip`, unless it explicitly sets
`allow_uninspected_credentials: true`. This is what makes
`openshell sandbox provider attach` fail against the stock image policy, whose
`statsig.anthropic.com` and `sentry.io` entries are L4-only —
`claude-code-l7.yaml` is the fix.
