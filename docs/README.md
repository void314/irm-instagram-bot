# Документация IRM Instagram AI Assistant

Multi-agent backend для AI-ассистента клиники IRM, обрабатывающего Instagram Direct через Facebook Login и Instagram Graph API.

## 📚 Содержание

- [Архитектура](#архитектура)
- [Pipeline обработки сообщений](#pipeline-обработки-сообщений)
- [Агенты](#агенты)
- [Хранилища данных](#хранилища-данных)
- [Инфраструктура](#инфраструктура)
- [Разработка](#разработка)

---

## Архитектура

Система построена на принципе **Collective Pipeline** — итеративном пайплайне, где оркестратор является единственным ответственным за формирование финального ответа пользователю.

```
Instagram DM → Webhook → Orchestrator
                              │
              ┌───────────────┼──────────────────┐
              ▼               ▼                    ▼
         ┌──────────────┐ ┌───────────┐ ┌─────────────────┐
         │  Tool Agent  │ │ RAG Agent │ │ Booking Agent   │
         │ (prices,     │ │(knowledge, │ │ (booking flow)  │
         │  schedule)   │ │composition│ └─────────────────┘
         └──────────────┘ └───────────┘
```

### Принципы

- **Оркестратор** — определяет интент, диспатчит суб-агентам, собирает данные, формирует финальный ответ с полной персоной (IRM_BASE + Айгерим)
- **Суб-агенты** — возвращают данные или готовые ответы (см. ниже)
- **Gap-сигналы** — если агент не может закрыть запрос полностью, он возвращает `gaps[]`, которые оркестратор закрывает другими агентами

### DATA_MODE_AGENTS

Агенты делятся на два типа:

| Тип                 | Агенты         | Возвращают     | Обработка                      |
| ------------------- | -------------- | -------------- | ------------------------------ |
| `DATA_MODE_AGENTS`  | `rag`, `tool`  | Сырые факты    | Проходят через `craftResponse` |
| `FINAL_MODE_AGENTS` | `conversation` | Готовые ответы | Возвращаются напрямую          |

**Booking и Objection** — это **режимы оркестратора** (Unified Orchestrator Pattern), а не отдельные агенты.
Они используют единый промпт IRM_BASE и возвращают готовые ответы.

### Итеративный цикл

```
1. Primary dispatch по intent → AgentResult
2. Если gaps есть и critical → войти в loop:
   selectNextAgent(gaps) → dispatch → merge → check gaps
3. Max 3 итерации + loop detection
4. Финальная синтезация (LLM с IRM_BASE) → все данные → ответ
5. Пост-обработка: имя, CTA, extractPatientData
```

---

## Pipeline обработки сообщений

### Fast-path (быстрые пути)

Простые интенты, не требующие поиска данных. Ответ формируется из шаблонов или одним прямым вызовом суб-агента.

```
detectIntentLLM
├── greeting         → handleConversationIntent → шаблоны
├── goodbye          → handleConversationIntent → шаблоны
├── gratitude        → handleConversationIntent → шаблоны
├── clear_context    → сброс summary/metadata в БД
├── provide_name     → extractNameCandidate → сохранить имя в БД
├── booking          → handleBookingIntent (сбор данных)
├── booking_decline  → BOOKING_DECLINE_RESPONSE
└── objection        → checkAndHandleObjection (скрипты)
```

### Pipeline (итеративный цикл)

Для интентов, где нужны реальные данные: `prices`, `query` (и `objection` если fast-path вернул null).

```
prices / query
     │
     ▼
dispatchAgent(primaryAgent)
     │
     ├── confidence='low' + gaps с priority='critical'
     │       → итеративный цикл (max 3 итерации)
     │
     └── confidence='high' / нет critical gaps
             → synthesizeFinalAnswer(query, accumulatedContent)
                  │
                  ▼
             LLM с IRM_BASE + patientContext + история + данные агентов
                  │
                  ▼
             связный естественный ответ
```

---

## Агенты

| Агент            | Задача                                            | Вход                                     | fillsGaps                                               |
| ---------------- | ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| **Orchestrator** | Интент, диспатч, синтез, персона, CTA, extraction | Любой query                              | —                                                       |
| **Conversation** | Приветствия, прощания, имя                        | `intent = greeting/goodbye/provide_name` | `[]`                                                    |
| **Tool**         | Цены, расписание, поиск врачей                    | `intent = prices`                        | `[price_info, schedule_info]`                           |
| **RAG**          | Поиск по БД знаний, описание программ             | `intent = query`                         | `[service_composition, general_knowledge, doctor_info]` |
| **Objection**    | Обработка возражений                              | `intent = objection`                     | `[]`                                                    |
| **Booking**      | Запись на приём (LLM-driven)                      | `intent = booking`                       | `[booking_data]`                                        |

### Protocol AgentResult

```typescript
interface AgentResult {
    content: string // ответ / данные
    confidence: 'high' | 'partial' | 'low'
    gaps: Gap[] // чего не хватает
    updatedPatient?: Record<string, unknown>
}

interface Gap {
    type: 'price_info' | 'service_composition' | 'schedule_info' | 'doctor_info' | 'general_knowledge' | 'booking_data'
    description: string
    priority: 'critical' | 'nice_to_have'
}
```

---

## Хранилища данных

### RAG Store + Learning Store

```
                    ┌─────────────────────┐
                    │    Orchestrator      │
                    │  hybridSearch(v2)    │
                    └──────┬──────┬───────┘
                           │      │
                    ┌──────▼─┐ ┌──▼────────┐
                    │  RAG    │ │  Learning │
                    │  Store  │ │  Store    │
                    │  (ручн) │ │  (авто)   │
                    └────┬────┘ └─────┬──────┘
                         │            │
                    ┌────▼────────────▼──────┐
                    │   pgvector (2 таблицы)  │
                    │  chunks + learn_chunks │
                    └────────────────────────┘
```

| Аспект     | RAG Store              | Learning Store                   |
| ---------- | ---------------------- | -------------------------------- |
| Таблицы    | `documents` → `chunks` | `learning_docs` → `learn_chunks` |
| source     | `manual`, `admin`      | `learning`                       |
| Наполнение | Админ вручную          | Learning agent (авто)            |
| Вес поиска | 1.0                    | 0.5                              |
| Отключение | Нет                    | Да (toggle)                      |

### hybridSearch

Оба хранилища опрашиваются, результаты объединяются с весами, дедуплицируются.

---

## Инфраструктура

| Компонент  | Технология                                  |
| ---------- | ------------------------------------------- |
| Runtime    | Bun                                         |
| Framework  | Elysia                                      |
| Database   | PostgreSQL + pgvector                       |
| ORM        | Drizzle                                     |
| Validation | Valibot + valibot-env                       |
| LLM        | OpenRouter (gpt-4o-mini, claude-3.5-sonnet) |
| Embeddings | OpenRouter (text-embedding-3-small)         |
| Queues     | BullMQ + Redis                              |
| Meta       | Instagram Graph API, Facebook Webhooks      |

---

## Разработка

### Структура проекта

```
src/
├── agents/
│   ├── orchestrator/       ← итеративный runPipeline + synthesis
│   ├── conversation/       ← быстрые regex-пути
│   ├── rag/                ← гибридный поиск
│   ├── tool/               ← prices, schedule, definitions
│   ├── booking/            ← LLM-driven диалог записи
│   ├── objection/          ← LLM-классификатор возражений
│   ├── types.ts            ← AgentResult, Gap, PipelineState
│   └── registry.ts         ← реестр агентов + selectNextAgent
│
├── services/
│   ├── llm/                ← OpenRouter (chat, embeddings)
│   ├── rag/                ← hybrid, intent, prompts, context, grounding
│   └── tools/              ← prices, schedule, definitions
│
├── modules/
│   ├── webhook/            ← Instagram webhook handler
│   ├── auth/               ← Facebook OAuth
│   ├── admin/              ← API endpoints
│   └── health/
│
├── db/
│   └── schema.ts           ← Drizzle schema
│
├── app.ts                  ← Elysia bootstrap
├── index.ts                ← точка входа
└── router.ts               ← API router
```

### Основные команды

```bash
# Установка зависимостей
bun install

# Запуск в режиме разработки
bun run dev

# Запуск тестов
bun test

# Генерация миграции
bun run db:generate

# Применение миграции
bun run db:migrate

# Форматирование
bun run format
```

---

## Документация

- [Архитектура](ARCHITECTURE.md) — подробное описание архитектуры системы
- [Pipeline обработки](message-flow.md) — детальное описание flow обработки сообщений
- [История изменений](CHANGELOG.md) — анализ сильных и слабых сторон, roadmap
- [Карта прайс-листов](1c-price-list-map.md) — маппинг филиалов и прайс-листов 1С
- [Instagram API](Instagram API with Facebook Login.md) — справочная документация API

## Визуализация

- [Excalidraw схема](Drawing 24.07.2026.excalidraw.md) — визуальное представление архитектуры multi-agent pipeline

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

## Лицензия

IRM Clinic

