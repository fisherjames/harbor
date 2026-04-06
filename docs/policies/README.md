# Policy Bundles

- `harness-policy-v1.json`: canonical policy-as-code document for signed workflow policy bundles.
- Policy bundles must include `policyVersion`, `algorithm`, `checksum`, and `signature`.
- Deploy/run paths verify policy checksum and signature before execution.
- Default runtime trust anchor is `harness-policy-v1` signature when no policy signing env vars are set.
- Use `pnpm policy:bundle -- sign --document docs/policies/harness-policy-v1.json --out /tmp/policy-bundle.json` to create a bundle.
- Use `pnpm policy:bundle -- verify --bundle /tmp/policy-bundle.json` to validate checksum/signature integrity.
