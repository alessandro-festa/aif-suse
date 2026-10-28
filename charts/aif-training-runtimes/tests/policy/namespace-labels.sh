#!/usr/bin/env bash
# aif-namespace-labels, as server-side dry runs: a project owner may not set, change or remove a
# namespace's KAI queue or ai-factory.suse.com/managed; an admin (the caller) may.
#   OWNER_GROUP  a group holding Rancher's project-owner role for OWNER_NS (impersonated)
#   OWNER_NS     a namespace in that project, with a queue (A);  OTHER_Q  another project's queue (B)
#   THIRD_Q      a third queue (C)
# With SCOPED=1, also per-queue grants (resourceNames), from two groups bound to the
# aif-queue-assigner rule for queue B only (aif-test-assign-b) and for A and B (aif-test-assign-ab):
# see queue-assigner-test-rbac.yaml.
#   CONTEXT=rke2 OWNER_GROUP=keycloakoidc_group://release-managers OWNER_NS=tenant-default \
#     OTHER_Q=aif-submit THIRD_Q=scdoc-transcription SCOPED=1 EMPTY_NS=aif-policy-probe \
#     OTHER_OWNER_NS=cattle-remuda-system TO_PROJECT=local:p-training tests/policy/namespace-labels.sh
# EMPTY_NS: a namespace in the owner's project with no queue; OTHER_OWNER_NS: another namespace in it;
# TO_PROJECT: another Rancher project.
set -u
K="kubectl --context ${CONTEXT:-rke2}"
AS="--as=namespace-labels-probe --as-group=${OWNER_GROUP:?} --as-group=system:authenticated"
NS=${OWNER_NS:?} Q=${OTHER_Q:?}
pass=0 fail=0
check() {  # want, description, kubectl label args... [-- annotate]
  want=$1 what=$2; shift 2
  verb=label; args=()
  for x in "$@"; do [ "$x" = "--" ] && { verb=; continue; }; [ -z "$verb" ] && { verb=$x; continue; }; args+=("$x"); done
  [ -z "$verb" ] && verb=label
  out=$($K "$verb" --dry-run=server --overwrite "${args[@]}" 2>&1)
  if echo "$out" | grep -q "(server dry run)"; then got=admitted; else got=refused; fi
  [ "$got" = "$want" ] && { pass=$((pass+1)); r=PASS; } || { fail=$((fail+1)); r=FAIL; }
  printf '%-4s %-8s %s  %s\n' "$r" "$got" "$what" "$(echo "$out" | sed -n 's/.*denied request: //p; s/.*denied the request: //p' | head -1 | cut -c1-90)"
}
echo "owner may edit $NS: $($K auth can-i patch namespace/$NS $AS 2>/dev/null)"
check refused "owner points $NS at another project's queue"  ns "$NS" kai.scheduler/queue="$Q" $AS
check refused "owner marks $NS managed"                       ns "$NS" ai-factory.suse.com/managed=true $AS
check refused "owner removes $NS's queue"                     ns "$NS" kai.scheduler/queue- $AS
check admitted "owner changes another label on $NS"           ns "$NS" example.com/team=a $AS
check admitted "admin points $NS at another queue"            ns "$NS" kai.scheduler/queue="$Q"
A=$($K get ns "$NS" -o jsonpath='{.metadata.labels.kai\.scheduler/queue}')
if [ "${SCOPED:-}" = 1 ]; then
  B_ONLY="$AS --as-group=aif-test-assign-b" AB="$AS --as-group=aif-test-assign-ab" MANAGE="$AS --as-group=aif-test-manage"
  C=${THIRD_Q:?} EMPTY=${EMPTY_NS:?} OTHER_NS=${OTHER_OWNER_NS:?}
  echo; echo "per-queue grants: $NS is on queue $A (A); B is $Q; C is $C; $EMPTY has no queue"
  # the question the policy asks, as a SubjectAccessReview (kubectl auth can-i can't name a resource
  # type that has no CRD)
  sar() { printf '{"apiVersion":"authorization.k8s.io/v1","kind":"SubjectAccessReview","spec":{"user":"namespace-labels-probe","groups":["%s","system:authenticated"],"resourceAttributes":{"group":"ai-factory.suse.com","resource":"namespacequeues","verb":"assign","name":"%s"}}}' "$1" "$2" |
          $K create -f - -o jsonpath='{.status.allowed}'; }
  echo "  SubjectAccessReview, assign B as B-only: $(sar aif-test-assign-b "$Q"); A as B-only: $(sar aif-test-assign-b "$A"); A as A+B: $(sar aif-test-assign-ab "$A")"
  check admitted "B-only assigns B to $EMPTY (no queue)"          ns "$EMPTY" kai.scheduler/queue="$Q" $B_ONLY
  check refused  "B-only assigns C to $EMPTY"                     ns "$EMPTY" kai.scheduler/queue="$C" $B_ONLY
  check refused  "B-only moves $NS from A to B (not allowed A)"   ns "$NS" kai.scheduler/queue="$Q" $B_ONLY
  check admitted "A+B moves $NS from A to B"                      ns "$NS" kai.scheduler/queue="$Q" $AB
  check refused  "A+B moves $NS from A to C (not allowed C)"      ns "$NS" kai.scheduler/queue="$C" $AB
  check refused  "B-only removes $NS's queue A"                   ns "$NS" kai.scheduler/queue- $B_ONLY
  check admitted "A+B removes $NS's queue A"                      ns "$NS" kai.scheduler/queue- $AB
  echo "managed, its own permission:"
  check refused  "A+B (queues only) marks $NS managed"            ns "$NS" ai-factory.suse.com/managed=true $AB
  check admitted "manager of $NS marks $NS managed"               ns "$NS" ai-factory.suse.com/managed=true $MANAGE
  check refused  "manager of $NS marks $OTHER_NS managed"         ns "$OTHER_NS" ai-factory.suse.com/managed=true $MANAGE
  check refused  "manager of $NS marks $EMPTY managed"            ns "$EMPTY" ai-factory.suse.com/managed=true $MANAGE
  echo "Rancher project ownership (Rancher's webhook, not this policy): a queue grant doesn't move projects"
  check refused  "A+B owner moves $NS into project ${TO_PROJECT:?}" ns "$NS" "field.cattle.io/projectId=$TO_PROJECT" $AB -- annotate
fi
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
