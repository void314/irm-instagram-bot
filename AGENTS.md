# Agent Guidelines (IRM Instagram AI Assistant)

This repository is a backend service for an AI assistant that handles Instagram Direct messages for the IRM clinic via Facebook Login and the Instagram Graph API.

## Key Tech

- Runtime: Bun
- Framework: Elysia
- Database: PostgreSQL + pgvector
- ORM: Drizzle
- Validation: valibot + valibot-env
- LLM + embeddings: OpenRouter
- Facebook SDK: https://github.com/facebook/facebook-nodejs-business-sdk
- Valibot docs: https://valibot.dev/llms.txt

## Project Structure

- `src/app.ts`: app bootstrap and global plugins
- `src/router.ts`: API router
- `src/modules/*`: feature modules (auth, instagram, webhook, rag, services, tokens, admin)
- `src/services/*`: LLM, RAG pipeline, tool calls (prices, doctors, schedule)
- `src/db/*`: schema and migrations (Drizzle)
- `docs/`: technical notes and references

## Development Rules

- Use Bun for installs and scripts (`bun install`, `bun run dev`).
- Keep modules consistent with current pattern: `index.ts` for controller, `model.ts` for schema, `service.ts` for business logic.
- Validate all config via `src/config/constants.ts` (valibot-env). Do not access raw env vars in feature code.
- Keep all API routes under `/api` and register in `src/router.ts`.
- Preserve existing error handling and logging plugins in `src/app.ts`.

## Database & Migrations

- Schema lives in `src/db/schema.ts`.
- Do not edit migrations manually. Use Drizzle scripts (`db:generate`, `db:migrate`).
- Use `pgvector` fields for embeddings and keep dimensions aligned with `EMBED_MODEL` output.

## Instagram + Facebook Integration

- OAuth, tokens, and webhook handling are under `src/modules/auth/facebook` and `src/modules/webhook/instagram`.
- Tokens are encrypted; use `src/lib/encryption.ts` and never log raw tokens.
- Do not hardcode App ID/Secret; use `.env` only.

## RAG Pipeline

- Core logic lives in `src/services/rag/*`.
- Documents and chunks are stored in `documents` and `chunks` tables.
- Follow existing orchestration flow: intent -> query rewrite -> retrieval -> grounding.

## Security & Privacy

- Treat patient data as sensitive. Avoid logging message text or PII unless required.
- Never include secrets in logs, errors, or responses.
- Prefer server-side validation before calling external APIs.

## Quality & Style

- Run formatting via `bun run format`.
- Keep function names descriptive and avoid deeply nested logic in controllers.
- Add minimal comments only when the logic is non-obvious.

## Documentation

- See `docs/` for implementation notes and Instagram API references.
