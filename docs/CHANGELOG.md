# История изменений IRM Instagram AI Assistant

## Обзор

IRM Instagram AI Assistant — backend-сервис, обрабатывающий Instagram Direct через Meta Graph API. Система оркестрирует диалоги с использованием LLM, RAG (Retrieval-Augmented Generation) и специализированного парсинга интентов (booking, prices, objections и др.).

---

## 🟢 Сильные стороны

### 1. Tech Stack & Performance
- **Bun** + **Elysia** обеспечивают крайне быстрое выполнение, оптимальный footprint памяти и нативную поддержку TypeScript без компиляции.
- **PostgreSQL** + **pgvector** с **Drizzle ORM** предоставляет масштабируемую архитектуру для реляционных данных (patients, conversations) и векторных поиск по схожести.

### 2. Orchestrator Architecture
- RAG pipeline (`src/agents/orchestrator/index.ts`) хорошо спроектирован. Последовательно обрабатывает интенты диалога, обрабатывает мелкие разговоры без вызовов LLM, обнаруживает возражения и поддерживает использование инструментов (например, получение актуальных цен).
- Реализация гибридного поиска (BM25 + Vector Search) в `hybrid.ts` обеспечивает высокий recall для извлечения документов.

### 3. Data Security & Encapsulation
- Валидация конфигурации через `valibot-env` (`constants.ts`) — надёжная.
- Использование зашифрованных токенов и безопасная обработка webhook-событий (`webhook/instagram/service.ts`) соответствует хорошим стандартам безопасности.

---

## 🔴 Уязвимости и области для улучшения

### 1. Database Migrations (`pgvector`)
**Проблема:** Сгенерированный SQL-миграция `0000_bent_morlun.sql` пытается создать колонку типа `vector`, но не выполняет явно `CREATE EXTENSION IF NOT EXISTS vector;`.

**Влияние:** На свежей PostgreSQL базе миграция упадёт, останавливая деплой.

**Статус:** ✅ Исправлено (применён патч к `0000_bent_morlun.sql`).

### 2. Multilingual Hybrid Search Constraints
**Проблема:** Алгоритм BM25 в `src/services/rag/hybrid.ts` был жёстко закодирован на использование `russian` словаря: `plainto_tsquery('russian', ${query})`. Так как приложение поддерживает RU, KK (казахский) и EN, компонент поиска по ключевым словам может работать плохо или пропускать результаты для не-русских запросов.

**Влияние:** Сниженное качество извлечения для пользователей, взаимодействующих на казахском или английском.

**Статус:** ✅ Исправлено (динамическое назначение текстового поискового конфига на основе определённого языка запроса).

### 3. Elysia Rate Limiting Warnings During Tests
**Проблема:** При запуске `bun test` выводит множество предупреждений: `[elysia-rate-limit] failed to determine client address`. Это происходит, потому что `app.handle(new Request(...))` не заполняет детали TCP-соединения, ожидаемые плагином rate limit.

**Влияние:** Загрязняет вывод тестов, хотя тесты проходят при запущенном Redis.

**Рекомендация:** Предоставлять mock IPs через заголовки или обходить rate limiter в тестовом окружении для чистоты логов. (Добавлены mock IPs в тестовые Requests).

### 4. Integration Dependencies
**Проблема:** Тестовый набор строго требует запущенных Redis и PostgreSQL (`ECONNREFUSED` наблюдался ранее).

**Влияние:** CI/CD пайплайны упадут, если резервные сервисы не инстанциированы (например, через Docker Compose) перед запуском тестов.

---

## История изменений

### 2026-07-24 — Рефакторинг документации
- ✅ Создан главный README.md с обзором проекта
- ✅ Обновлена ARCHITECTURE.md на основе Excalidraw схемы
- ✅ Удалён collective-pipeline-plan.md (содержание интегрировано)
- ✅ Обновлена message-flow.md для отражения текущей архитектуры
- ✅ Переименован project_evaluation.md в CHANGELOG.md

### 2026-07-22 — Карта прайс-листов
- ✅ Добавлена карта маппинга филиалов и прайс-листов 1С

### 2026-07-20 — Phase 1 Foundation завершена
- ✅ Redis + BullMQ в docker-compose
- ✅ Booking Agent (эмуляция)
- ✅ Admin endpoints

### 2026-07-15 — Phase 2 начата
- 🔄 BullMQ jobs: process-correction
- 🔄 BullMQ cron: generate-kb-suggestions
- 🔄 Response override в оркестраторе

---

## Roadmap

### Phase 1 — Foundation ✓
- Redis + BullMQ в docker-compose
- Booking Agent (эмуляция)
- Admin endpoints

### Phase 2 — Learning Engine
- BullMQ jobs: process-correction
- BullMQ cron: generate-kb-suggestions
- Response override в оркестраторе

### Phase 3 — Booking Integration
- Замена эмуляции на реальную API

---

## Заключение

Кодовая база представляет собой надёжный, production-ready фундамент со сложной маршрутизацией функций. Наблюдаемые проблемы были в основном edge cases, связанными с процедурами настройки (миграции) и многоязычными edge cases (BM25 текстовые конфиги), которые были устранены.
