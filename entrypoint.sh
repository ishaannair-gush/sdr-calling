#!/bin/sh
set -e

# Materialize Google service-account files from env (same account for both).
if [ -n "$GOOGLE_CREDENTIALS_JSON" ]; then
  [ -f lead-estimator/credentials.json ] || printf '%s' "$GOOGLE_CREDENTIALS_JSON" > lead-estimator/credentials.json
  [ -f no-booking/google-credentials.json ] || printf '%s' "$GOOGLE_CREDENTIALS_JSON" > no-booking/google-credentials.json
fi

exec node index.js
