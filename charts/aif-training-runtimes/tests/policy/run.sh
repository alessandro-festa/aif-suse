#!/usr/bin/env bash
# The policy cases, as server-side dry runs: admission runs (Trainer's webhook, KAI's, and this
# chart's policies), nothing is created. Needs the chart installed with policy.actions [Deny], and:
#   NS        a managed project namespace with a KAI queue of the same name (default aif-submit)
#   OTHER_Q   another project's KAI queue (default scdoc-transcription)
#   OTHER_NS  a namespace outside policy.namespaceSelector (default tenant-default)
# The multi-node-rwo-outputs case expects outputs.enabled with ReadWriteOnce outputs. gen.py
# writes the cases.
#   CONTEXT=rke2 tests/policy/run.sh
cd "$(dirname "$0")"
NS=${NS:-aif-submit} OTHER_Q=${OTHER_Q:-scdoc-transcription} OTHER_NS=${OTHER_NS:-tenant-default}
pass=0 fail=0
for f in [0-9]*.yaml; do
  n=${f%.yaml}
  want=$(grep "^$n:" expected.txt | cut -d' ' -f2 | tr -d :)
  out=$(sed -e "s/namespace: tenant-default/namespace: $OTHER_NS/" -e "s/namespace: aif-submit/namespace: $NS/" \
            -e "s/: aif-submit$/: $NS/" -e "s/scdoc-transcription/$OTHER_Q/" "$f" |
        kubectl --context "${CONTEXT:-rke2}" create --dry-run=server -f - 2>&1)
  if echo "$out" | grep -q "(server dry run)"; then got=admitted; else got=refused; fi
  why=$(echo "$out" | sed -n 's/.*denied request: //p; s/.*denied the request: //p' | head -1 | cut -c1-110)
  if [ "$got" = "$want" ]; then pass=$((pass+1)); r=PASS; else fail=$((fail+1)); r=FAIL; fi
  printf '%-4s %-30s %-8s %s\n' "$r" "$n" "$got" "$why"
done
echo; echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
