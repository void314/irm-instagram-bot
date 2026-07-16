# Elysia + Bun — starter template

Шаблон для быстрого старта TypeScript API на Elysia с готовыми базовыми плагинами: OpenAPI, валидация схем через Valibot, логирование, CORS, rate limit, статические файлы, Server-Timing и OpenTelemetry.

## Что внутри

- **Runtime**: Bun
- **Web framework**: Elysia
- **OpenAPI**: `/docs` (с маппингом Valibot → JSON Schema)
- **ENV**: типобезопасные переменные окружения через `valibot-env`
- **Observability**: OpenTelemetry (OTLP exporter)
- **Прочее**: CORS, rate limit, Server-Timing, static files из `public/`

## Быстрый старт (Windows / PowerShell)

```powershell
bun install
bun run dev
```

После запуска:

- API: `http://localhost:3032/api`
- Healthcheck: `http://localhost:3032/api/health`
- OpenAPI (Swagger UI): `http://localhost:3032/docs`
- Статика: `http://localhost:3032/` (файлы из `public/`)

Порт по умолчанию — `3032` (см. переменные окружения ниже).

## Скрипты

- `bun run dev` — запуск в watch-режиме (`src/index.ts`)
- `bun test` — тесты (`bun:test`)
- `bun run format` — форматирование Prettier (включая сортировку импортов)

## Переменные окружения

Bun автоматически подхватывает `.env` (можно положить в корень репозитория).

- `PORT` (number, default: `3032`) — порт сервера
- `NODE_ENV` (`development | production | test`, default: `development`)
- `PUBLIC_APP_NAME` (string, default: `package.json:name`) — используется в OpenAPI
- `PUBLIC_APP_VERSION` (string, default: `package.json:version`) — используется в OpenAPI
- `RATE_LIMIT_MAX_REQUESTS` (number, default: `100`) — лимит запросов
- `RATE_LIMIT_WINDOW` (number, default: `60000`) — окно лимита в мс
- `VERCEL_ENV` (`development | preview | production`, default: `development`)

## Структура проекта

- `src/index.ts` — точка входа (поднимает сервер)
- `src/app.ts` — конфигурация Elysia и подключение плагинов
- `src/router.ts` — общий роутер с префиксом `/api`
- `src/modules/*` — модули (пример: `health`)
- `src/plugins/*` — плагины/кросс-каттинг логика (пример: глобальный error handler)
- `test/*` — тесты

## Пример эндпоинта

Модуль health:

- `GET /api/health` → `{ "status": "online" }`

Тесты написаны в стиле Elysia: без поднятия сервера, через `app.handle(new Request(...))`.

## OpenTelemetry (коротко)

В шаблоне включен OTLP Trace Exporter. Настройка отправки трейсов обычно делается переменными окружения OpenTelemetry (например, `OTEL_EXPORTER_OTLP_ENDPOINT`). Если коллектора нет — приложение продолжит работать, но экспорт может не происходить.

