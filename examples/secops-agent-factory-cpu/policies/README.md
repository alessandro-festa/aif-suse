# The policies are not here

They live in the chart:

```
charts/secops-cpu-agents/files/policies/
├── _README.md         the map: what each file grants and what it withholds
├── triage.yaml
├── researcher.yaml
├── clarifier.yaml
├── remediation.yaml
└── validation.yaml
```

This directory exists only because the GPU profile keeps its one policy in
`../../secops-agent-factory/policies/`, so that is where a reader arriving from
the parent example will look first.

## Why they moved

The GPU profile's `remediation-sandbox.yaml` is applied by hand:
`openshell policy set … --policy remediation-sandbox.yaml`. Nothing installs
it, so a file in the example directory is the only place it could be.

Here the orchestrator passes each policy to `openshell sandbox create --policy`
inside the cluster, which means the file has to arrive in the pod, which means
a ConfigMap, which means the chart. Keeping a second copy under `examples/` for
readability would give two files that are supposed to be the same and no
mechanism that says so — and the copy that drifts would be the one a reviewer
reads while the other is the one that runs. For the security boundary of the
whole profile that is not a trade worth making.

They are also Helm-templated: two hostnames — the SUSE Security controller API
and the in-cluster forge — depend on the namespaces this profile is installed
into, so the source files are not directly applicable anyway.

## Reading the effective policy

Review the rendered output, not the source:

```sh
helm template secops-cpu-agents charts/secops-cpu-agents \
  | yq 'select(.metadata.name == "secops-cpu-agent-policies") | .data'
```

Or, against a live install:

```sh
kubectl -n ns-secops-cpu get configmap secops-cpu-agent-policies \
  -o jsonpath='{.data.researcher\.yaml}'
```

## Checking one before it ships

There is no `openshell policy lint`. The strict client-side parser is reachable
through a `set` against a workspace that does not exist — it parses the file
before it discovers the workspace is missing, so a parse error surfaces and
nothing is changed:

```sh
openshell -g <gateway> policy set __nonexistent__ --policy /tmp/researcher.yaml
```

Run it on the **rendered** file. Every struct in the parser carries
`#[serde(deny_unknown_fields)]`, so a typo'd key is a hard error rather than a
grant silently dropped.
