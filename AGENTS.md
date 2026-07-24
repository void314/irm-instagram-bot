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

## 📚 Documentation Guidelines

**Always consult the documentation in `docs/` before making significant changes.** The docs are the single source of truth for system architecture and implementation details.

### When to Check Documentation

| Scenario                                  | Which Doc to Check                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Adding new agent or modifying pipeline    | [ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                   |
| Modifying message flow or intent handling | [message-flow.md](docs/message-flow.md)                                                   |
| Understanding multi-agent orchestration   | [README.md](docs/README.md)                                                               |
| Working with database schema              | [ARCHITECTURE.md](docs/ARCHITECTURE.md) (Section 4)                                       |
| Implementing new API endpoint             | [README.md](docs/README.md) (Section 7)                                                   |
| Working with pricing/booking tools        | [1c-price-list-map.md](docs/1c-price-list-map.md)                                         |
| Instagram API questions                   | [Instagram API with Facebook Login.md](docs/Instagram%20API%20with%20Facebook%20Login.md) |
| Reviewing project history/roadmap         | [CHANGELOG.md](docs/CHANGELOG.md)                                                         |

### Documentation-First Development

1. **Before coding**: Read the relevant docs to understand the current architecture
2. **Before refactoring**: Check if there are known issues or recent changes in CHANGELOG.md
3. **Before adding features**: Review ARCHITECTURE.md to ensure alignment with multi-agent pattern
4. **Before database changes**: Check schema in ARCHITECTURE.md Section 4

### Visual Architecture

For quick understanding of the system flow, refer to:

- [Excalidraw diagram](docs/Drawing%2024.07.2026.excalidraw.md) — visual overview of multi-agent pipeline
- [message-flow.md](docs/message-flow.md) — detailed message processing flow

### Documentation Maintenance

When making changes to the codebase:

1. **Update docs first** if architecture changes
2. **Add to CHANGELOG.md** for significant features/fixes
3. **Update ARCHITECTURE.md** if agent pipeline or data flow changes
4. **Keep README.md** updated with current tech stack and commands

---

## 📖 Documentation Reference

### Quick Start Docs

| File                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| [README.md](docs/README.md)             | Project overview, tech stack, quick commands   |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full system architecture, agents, pipeline     |
| [message-flow.md](docs/message-flow.md) | Message processing flow, fast-path vs pipeline |
| [CHANGELOG.md](docs/CHANGELOG.md)       | Project history, known issues, roadmap         |

### Technical Reference Docs

| File                                                                                      | Purpose                            |
| ----------------------------------------------------------------------------------------- | ---------------------------------- |
| [1c-price-list-map.md](docs/1c-price-list-map.md)                                         | Clinic branch & price list mapping |
| [Instagram API with Facebook Login.md](docs/Instagram%20API%20with%20Facebook%20Login.md) | Instagram Graph API reference      |

### Visual Documentation

| File                                                                        | Purpose                            |
| --------------------------------------------------------------------------- | ---------------------------------- |
| [Drawing 24.07.2026.excalidraw.md](docs/Drawing%2024.07.2026.excalidraw.md) | Multi-agent pipeline visualization |

---

## 🚀 Quick Commands

```bash
# Install dependencies
bun install

# Run development server
bun run dev

# Run tests
bun test

# Generate database migration
bun run db:generate

# Apply database migrations
bun run db:migrate

# Format code
bun run format
```

