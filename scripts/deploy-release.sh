#!/usr/bin/env bash
set -euo pipefail

# Run on the existing K3s server. KUBECTL_BIN is optional for other contexts/tests.
usage() {
  echo 'Usage: bash deploy-release.sh deploy <bundle> | rollback <bundle> --compatible' >&2
  exit 2
}
[[ $# -ge 2 && $# -le 3 ]] || usage
mode=$1
bundle=$2
case "$mode" in
  deploy) [[ $# -eq 2 ]] || usage ;;
  rollback) [[ ${3:-} == --compatible ]] || usage ;;
  *) usage ;;
esac
for file in commit.txt image.txt migrate.yaml test-receiver.yaml hookrelay.yaml worker.yaml relay.yaml; do
  [[ -f "$bundle/$file" ]] || { echo "Missing bundle file: $file" >&2; exit 1; }
done
commit=$(cat "$bundle/commit.txt")
image=$(cat "$bundle/image.txt")
[[ $commit =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid bundle commit' >&2; exit 1; }
[[ $image =~ ^ghcr\.io/[a-z0-9][a-z0-9._/-]*:sha-$commit@sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid bundle image or mismatched commit' >&2; exit 1; }
for file in migrate.yaml test-receiver.yaml hookrelay.yaml worker.yaml relay.yaml; do
  grep -Fqx "          image: $image" "$bundle/$file" || { echo "Image mismatch in $file" >&2; exit 1; }
done
kubectl_command() {
  if [[ -n ${KUBECTL_BIN:-} ]]; then
    "$KUBECTL_BIN" -n hookrelay "$@"
  else
    sudo k3s kubectl -n hookrelay "$@"
  fi
}

# One operation at a time on this server, including manual rollbacks.
exec 9>"${TMPDIR:-/tmp}/hookrelay-release.lock"
flock -n 9 || { echo 'Another release operation is running' >&2; exit 1; }
kubectl_command get secret ghcr-credentials >/dev/null
for deployment in hookrelay worker relay test-receiver; do
  kubectl_command get deployment "$deployment" >/dev/null
done
[[ $(kubectl_command get deployment relay -o 'jsonpath={.spec.replicas}:{.spec.strategy.type}') == '1:Recreate' ]] || {
  echo 'Expected exactly one relay with Recreate strategy' >&2; exit 1;
}

# Record the previous images before changing any application.
echo 'Current application images (save these with the release record):'
for deployment in hookrelay worker relay test-receiver; do
  printf '%s: ' "$deployment"
  kubectl_command get deployment "$deployment" -o 'jsonpath={.spec.template.spec.containers[0].image}'
  printf '\n'
done
if [[ $mode == deploy ]]; then
  job="hookrelay-migrate-$commit"
  # Jobs are immutable. Reuse a successfully completed job; never delete/retry a
  # failed one automatically, since a migration may already have changed data.
  existing=$(kubectl_command get job "$job" --ignore-not-found -o name)
  if [[ -z $existing ]]; then
    kubectl_command create -f "$bundle/migrate.yaml"
  else
    [[ $(kubectl_command get job "$job" -o 'jsonpath={.spec.template.spec.containers[0].image}') == "$image" ]] || {
      echo 'Existing migration Job uses another digest; stop and inspect it' >&2; exit 1;
    }
  fi
  if ! kubectl_command wait --for=condition=complete "job/$job" --timeout=180s; then
    kubectl_command logs "job/$job" || true
    echo 'Migration did not complete; application versions were not changed' >&2
    exit 1
  fi
else
  echo 'Compatibility acknowledged: restoring application manifests; database migrations remain applied.'
fi

for deployment in test-receiver hookrelay worker relay; do
  kubectl_command apply -f "$bundle/$deployment.yaml"
  kubectl_command rollout status "deployment/$deployment" --timeout=180s
  actual=$(kubectl_command get deployment "$deployment" -o 'jsonpath={.spec.template.spec.containers[0].image}')
  [[ $actual == "$image" ]] || { echo "Unexpected image for $deployment" >&2; exit 1; }
done
echo "Application rollout completed at $commit ($mode)."
echo 'Now run the remote readiness and delivery smoke check from docs/versioned-deployment.md.'
