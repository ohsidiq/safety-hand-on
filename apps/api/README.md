# apps/api

Core API tipis (Hono + `@hono/zod-openapi`), kontrak OpenAPI 3.1 di `openapi/v1.yaml` (ARCH-003).
Basis `/api/v1`, amplop respons, `X-Request-Id`, katalog galat API-000.

- `GET /api/v1/health/live`, `GET /api/v1/health/ready` (tanpa autentikasi, tanpa detail internal)
- `GET /api/v1/openapi.json`

Kueri bisnis wajib lewat `withUser` (`@soh/db`) agar RLS berlaku (ARCH-002). Autentikasi dan RBAC: M1.
