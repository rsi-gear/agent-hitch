#!/bin/sh
set -eu
mkdir -p /logs/verifier
printf 'Hello, Hitch!\n' > /logs/verifier/expected.txt
if cmp -s /app/answer.txt /logs/verifier/expected.txt; then
  printf '1\n' > /logs/verifier/reward.txt
else
  printf '0\n' > /logs/verifier/reward.txt
fi
printf 'hello-hitch verifier completed\n'
