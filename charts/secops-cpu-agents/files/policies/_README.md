# The six policies

One file per agent. Each is a **complete, standalone** OpenShell sandbox policy — the
filesystem baseline and the landlock and process stanzas are repeated verbatim in all six
rather than factored out.

That duplication is deliberate. These are the security boundary of the whole profile, and
the property you want when reading one is *"this file tells me everything this agent can
do"*. A shared base that a reader has to go and find is a base a reviewer skips, and the
grant they then reason about is not the grant that runs.

## Why there are six and not one

`../../../../examples/secops-agent-factory/policies/remediation-sandbox.yaml` is a single
policy covering the two sandboxed agents of the GPU profile; the other eight share one AI-Q
pod and one ordinary NetworkPolicy. This profile inverts that: **every agent is sandboxed,
and each carries only its own row.**

| Policy | May reach | Notably may **not** |
|---|---|---|
| `survey.yaml` | SUSE Security (read all findings), the forge — **one issue** | scan; clone; comment on the issue it opened |
| `triage.yaml` | SUSE Security (read), SUSE Application Collection (tag lists), the corpus | scan; the forge |
| `researcher.yaml` | the corpus, and nothing else | SUSE Security, the forge |
| `clarifier.yaml` | the forge — issues and `git-upload-pack` | `git-receive-pack`, i.e. it cannot push |
| `remediation.yaml` | the forge (push + open a PR), the corpus | merge its own PR; SUSE Security; the catalogue |
| `validation.yaml` | SUSE Security (scan), the forge (comment only) | open or merge a PR; the corpus |

Each of those "may not" cells is checkable from a live terminal, and the README's isolation
proof does exactly that. On the GPU profile none of them are, because the eight agents that
would have to be separated are in the same pod.

Three rows are worth reading together, because the split between them is the newest design
decision here and the least obvious. **Survey** can see every finding in the cluster and can
publish exactly one issue; it holds no catalogue credential, so it cannot propose a
replacement image, and it cannot comment on its own issue, so it cannot answer the question
it asked. **Triage** holds the catalogue credential but runs only after a human has picked
one image, and cannot write to the forge at all. **Remediation** writes, and holds neither
of the read credentials — it is handed a target version, quoted by triage, rather than being
in a position to invent one. There is no sandbox in this profile from which the whole
"find a CVE → choose a replacement → push it" chain can be driven.

## A helper on disk is not a grant

Helper scripts in `/sandbox/bin` follow the *provider* an agent attaches, and one of them —
`corpus` — is given to everyone because it spends no credential. So a sandbox can hold a
script whose traffic its own policy denies: `survey` has `forge-clone` and `corpus` and can
use neither. That is intentional and worth demonstrating rather than tidying away. The
filesystem is not the boundary; these files are.

## These files are Helm-templated

They contain `{{ .Values.… }}` references for the in-cluster hostnames — the SUSE Security
controller API, the Gitea service, Qdrant — because those depend on the namespaces this
chart is installed into. Everything else is literal.

Read the effective policy, not the source, when reviewing a deployment:

```sh
helm template secops-cpu-agents charts/secops-cpu-agents \
  | yq 'select(.metadata.name == "secops-cpu-agent-policies") | .data'
```

## The absences are load-bearing

There is no rule for `inference.local` in any of the six. That is not an oversight: it is a
built-in supervisor route, short-circuited before `network_policies` is consulted, so a rule
for it would do nothing. Every agent reaches the model; none of them reach it over the
network.

There is no rule for `pypi.org`, `registry.npmjs.org`, `api.github.com` or `github.com` in
any of the six either.

**There are exactly two public hosts in the whole set**, and everything else these agents
can reach is inside the cluster.

`dp.apps.rancher.io`, in `triage.yaml` alone. What crosses the boundary there is a container
image name and a credential the sandbox never holds; what comes back is a list of tags. For
an air-gapped deployment, mirror the catalogue's tag index into the cluster and repoint
`appCollection.host` at the mirror — the policy grant, the helper and the provider profile
all keep working unchanged.

`cveawg.mitre.org`, in `researcher.yaml` and `clarifier.yaml`, added in 0.3.3 and **the only
one of the two that can be switched off**: `cveLookup.enabled: false` removes the block from
both policies. GET-only, one path, and no `credential_binding` at all — there is no secret
to spend against it. It is there because those two agents were the ones caught inventing
citations, and a record the reviewer can open is the cheapest fix for that. With it off, the
profile is one mirrored tag index away from needing no internet at all; read the `cveLookup`
comment in `values.yaml` before deciding.
