# IRM Instagram AI Assistant

Сервис ИИ-ассистента для Instagram Direct клиники IRM. Обрабатывает входящие сообщения, отвечает на вопросы пациентов, использует RAG на базе клинических документов и интегрируется с внешними сервисами клиники (цены, врачи, расписание).

## Основные возможности

- Прием и обработка входящих Instagram сообщений через Facebook Login и Instagram Graph API
- Контекстные ответы на базе RAG (документы и чанки в Postgres + pgvector)
- Интеграции с внешним API клиники (цены, врачи, расписание)
- Валидация и контроль конфигурации через типобезопасный env

## Стек

- Runtime: Bun
- Framework: Elysia
- Database: PostgreSQL + pgvector
- ORM: Drizzle
- Validation: valibot + valibot-env
- LLM + embeddings: OpenRouter
- Facebook SDK: https://github.com/facebook/facebook-nodejs-business-sdk

## Быстрый старт

1. Установите зависимости: `bun install`
2. Поднимите Postgres с pgvector: `docker-compose up -d`
3. Скопируйте `.env.example` в `.env` и заполните значения
4. Примените миграции: `bun run db:migrate`
5. Запустите сервис: `bun run dev`

После запуска:

- API: `http://localhost:3032/api`
- Healthcheck: `http://localhost:3032/api/health`
- OpenAPI (Swagger UI): `http://localhost:3032/docs`

Порт по умолчанию — `3032`.

## Переменные окружения

Полный список смотрите в `.env.example`. Ключевые группы:

- Database: `DATABASE_URL`
- Server: `PORT`, `NODE_ENV`
- Rate Limit: `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW`
- Meta/Facebook: `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_GRAPH_API_VERSION`, `FACEBOOK_PAGE_ID`
- Instagram: `INSTAGRAM_BUSINESS_ID`
- Webhook: `WEBHOOK_VERIFY_TOKEN`, `WEBHOOK_AUTO_REPLY_TEXT`
- Token Encryption: `TOKEN_ENCRYPTION_KEY`
- RAG/LLM: `OPENROUTER_BASE_URL`, `OPENROUTER_API_KEY`, `LLM_MODEL`, `EMBED_MODEL`, `RAG_TOP_K`
- External API: `EXTERNAL_API_BASE_URL`

## Скрипты

- `bun run dev` — запуск в watch-режиме (`src/index.ts`)
- `bun test` — тесты (`bun:test`)
- `bun run format` — форматирование Prettier
- `bun run db:generate` — генерация миграций Drizzle
- `bun run db:migrate` — применение миграций
- `bun run db:studio` — визуальная работа с БД

## Структура проекта

- `src/index.ts` — точка входа
- `src/app.ts` — подключение плагинов и глобальных middleware
- `src/router.ts` — общий роутер с префиксом `/api`
- `src/modules/*` — бизнес-модули (auth, instagram, webhook, rag, services, tokens, admin)
- `src/services/*` — LLM, RAG и tool-функции
- `src/db/*` — schema + миграции Drizzle
- `docker/` — init-скрипты для Postgres
- `docs/` — технические заметки

## Безопасность

- Не логируйте сообщения пациентов и любые PII без необходимости.
- Не храните токены в открытом виде — используйте шифрование.

## Документация

- `docs/` — детали интеграции и справочные материалы

