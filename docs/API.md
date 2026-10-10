# HTTP API

The complete Kuch HTTP API — every route of `api/server.js`, with auth,
request/response schemas and the env-dependent behavior — is documented as a
hand-written OpenAPI 3.1 spec:

- **Spec (source of truth):** [`api/openapi.yaml`](../api/openapi.yaml)
- **Browsable (Swagger UI):** [`website/api.html`](../website/api.html), generated from the spec by `scripts/build-api-docs.mjs`

Lint it after changing routes:

```sh
npx --yes @redocly/cli lint api/openapi.yaml
```
