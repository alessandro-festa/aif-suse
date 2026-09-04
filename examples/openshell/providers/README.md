# OpenShell providers and inference routing

Provider *instances* and *profiles* are gateway state, not Helm values. Blueprint
A configures only where credential material is **stored**
(`server.credentialStorage.existingSecret`, `server.credentialDrivers.*`); the
providers themselves are created here with the CLI.

A **profile** defines a provider *type*: its credentials, the endpoints those
credentials are bound to, and the binaries allowed to use them. A **provider
instance** holds the concrete values for one gateway. Attaching a provider to a
sandbox contributes generated `_provider_*` entries to the sandbox's effective
policy — which is why policy travels with the credential instead of being
copy-pasted into every sandbox.

## Everything here is workspace-scoped

`provider create`, `provider profile import` and `inference set` all carry a
workspace and default to `default`. In the two-Blueprint topology the workspace
is the tenant namespace, so **every command below needs `--workspace <tenant>`**
— run them once per tenant. Omit it and the provider lands in `default`, where
no tenant sandbox can see it: sandboxes get "no inference route configured" and
`provider attach` reports the provider as not found.

Profiles are the exception: `provider profile import --global` registers a
platform-scoped profile usable from every workspace, and `provider create
--global-profile` consumes one. Provider *instances* are always
workspace-scoped — they hold credentials.

(Older OpenShell required `settings set --global --key providers_v2_enabled`.
That key was removed; v2 is the only mode and setting it now fails with an
unknown-key error.)

## Two different things you might want

### 1. Route `inference.local` at an in-cluster engine

This is the common case and it needs **no custom profile**. Use the built-in
`openai` profile with an alternate base URL:

**This command is where the per-tenant / shared engine choice is actually
made** — the two Ollama blueprints differ only in where the Service ends up, so
the URL below is the whole decision. It is reversible: route bundles refresh
every ~5 s, so re-running these two commands moves a tenant between engines with
no sandbox restart.

```shell
# Ollama, per-tenant engine (Blueprint C1 — 40-...-ollama-tenant.yaml)
openshell -g <gateway> --workspace <tenant> provider create \
  --name ollama-local \
  --type openai \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://ollama.<tenant>.svc.cluster.local:11434/v1

# Ollama, shared engine (Blueprint C2 — 41-...-ollama-shared.yaml)
openshell -g <gateway> --workspace <tenant> provider create \
  --name ollama-shared \
  --type openai \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://ollama.openshell.svc.cluster.local:11434/v1

# LiteLLM (shipped "suse-inference-endpoint" blueprint)
openshell -g <gateway> --workspace <tenant> provider create \
  --name suse-litellm \
  --type openai \
  --credential OPENAI_API_KEY=<litellm-virtual-key> \
  --config OPENAI_BASE_URL=http://litellm.<ns>.svc.cluster.local:4000/v1

openshell -g <gateway> --workspace <tenant> inference set \
  --provider ollama-local --model qwen2.5:0.5b
openshell -g <gateway> --workspace <tenant> inference get
```

Setting an alternate base URL deliberately makes the built-in `openai` and
`anthropic` profiles **route-only**: OpenShell withholds their static
credentials and vendor policy from direct sandbox traffic, while gateway
inference routing keeps using the configured upstream. That is the behaviour you
want here — the sandbox never holds the key.

`inference set` probes the upstream before saving. If the engine is still
pulling its model, either wait or pass `--no-verify` and re-run `inference get`
later.

Ollama ignores the API key, but `--type openai` requires one to be present.
Credential keys are environment variable **names**, not field names —
`OPENAI_API_KEY=...`, never `api_key=...`.

### 2. Let sandboxes call the engine directly

Use a custom profile when code in the sandbox should reach the endpoint itself
and OpenShell should inject the credential at the proxy. That is what
`suse-litellm-profile.yaml` is for.

```shell
openshell -g <gateway> provider profile lint   -f suse-litellm-profile.yaml
openshell -g <gateway> provider profile import -f suse-litellm-profile.yaml --global
openshell -g <gateway> --workspace <tenant> provider create \
  --name litellm-direct --type suse-litellm --global-profile \
  --credential OPENAI_API_KEY=<litellm-virtual-key>
openshell -g <gateway> --workspace <tenant> sandbox provider attach <sandbox> litellm-direct
openshell -g <gateway> --workspace <tenant> policy get <sandbox> --full   # the _provider_* rules
```

`--global` imports the profile once for the whole gateway; `--global-profile`
tells `provider create` to resolve the type against platform scope rather than
the tenant's own. Drop both flags to keep the profile private to one workspace,
in which case it must be imported per tenant.

Import is create-only. To change an imported profile, `export` it (the export
carries a `resource_version` that must be preserved), edit, then `update`.

## Gotchas

- **`inference_capable` is metadata only.** Attaching an inference-capable
  provider does not create `inference.local` routes; only `inference set` does.
- **Static credentials are endpoint-bound.** A placeholder resolves only for the
  host, port and path declared by the profile's endpoints. A mismatch is
  rejected with HTTP 403 `credential_endpoint_mismatch`, not a silent fallback.
- **`attach` re-validates against the image's policy.** If it fails with
  "uses L4-only", the sandbox's policy declares that endpoint without a
  `protocol:`. See `../policies/claude-code-l7.yaml`.
- **Custom profile IDs are lowercase kebab-case** and cannot shadow a built-in
  (`claude-code`, `codex`, `copilot`, `github`, `google-vertex-ai`, `nvidia`,
  `openai`, `anthropic`).
