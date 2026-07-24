# IRM Instagram AI Assistant — Архитектура

## Цель

Multi-agent backend для AI-ассистента клиники IRM, обрабатывающего Instagram Direct.
Система использует RAG (Retrieval-Augmented Generation) и оркестратор суб-агентов.

---

## 1. Collective Pipeline — текущая архитектура

```
Instagram DM ──► Webhook ──► Orchestrator (runPipeline)
                                    │
                    ┌───────────────┼──────────────────┐
                    ▼               ▼                    ▼
           ┌────────────────┐ ┌────────────┐ ┌──────────────────┐
           │  Tool Agent    │ │  RAG Agent │ │  Booking Agent   │
           │ (prices, docs, │ │(knowledge, │ │  (booking flow)  │
           │  schedule)     │ │ composition│ └──────────────────┘
           └───────┬────────┘ └─────┬──────┘
                   │                │
           ┌───────▼────────────────▼──────┐
           │    Conversation / Objection   │
           │    (быстрые regex/LLM пути)   │
           └───────────────────────────────┘
```

Все агенты возвращают `AgentResult { content, confidence, gaps[] }`

### Принцип

- **Оркестратор** — единый ответственный за ответ пользователю.
  Определяет интент, диспатчит суб-агентам, собирает данные,
  формирует финальный ответ с полной персоной (IRM_BASE + Айгерим).
- **Суб-агенты** — возвращают данные, а не готовые ответы.
  Не содержат CTA, не персонализируют.
- **Gap-сигналы** — если агент не может закрыть запрос полностью,
  он возвращает `gaps[]`, которые оркестратор закрывает другими агентами.

### Типы

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

### Итеративный цикл

```
1. Primary dispatch по intent → AgentResult
2. Если gaps есть и critical → войти в loop:
   selectNextAgents(gaps) → dispatch → merge → check gaps
3. Max 3 итерации + loop detection
4. Финальная синтезация (LLM с IRM_BASE) → все данные → ответ
5. Пост-обработка: имя, CTA, extractPatientData
```

---

## 2. Агенты

| Агент            | Задача                                            | Вход                                     | Возвращает    |
| ---------------- | ------------------------------------------------- | ---------------------------------------- | ------------- |
| **Orchestrator** | Интент, диспатч, синтез, персона, CTA, extraction | Любой query                              | Готовый ответ |
| **Conversation** | Приветствия, прощания, имя                        | `intent = greeting/goodbye/provide_name` | Готовый ответ |
| **Tool**         | Цены, расписание, поиск врачей                    | `intent = prices`                        | Данные + gaps |
| **RAG**          | Поиск по БД знаний, описание программ             | `intent = query`                         | Данные + gaps |
| **Objection**    | Обработка возражений                              | `intent = objection`                     | Готовый ответ |
| **Booking**      | Запись на приём (LLM-driven)                      | `intent = booking`                       | Готовый ответ |
| **Learning**     | Сбор фидбека, генерация KB (фоново)               | Admin + BullMQ                           | —             |

### Conversation Agent

Быстрый путь (regex, без LLM). Возвращает `AgentResult` с `confidence: 'high'`.

### Tool Agent

Вызывает `executeTool('get_prices')`. Если не нашёл — возвращает `gaps: [service_composition]`.

### RAG Agent

Гибридный поиск (BM25 + vector). Возвращает контекст из БЗ.
Если контекст найден — `confidence: 'high'`, если нет — `'partial'`.

### Objection Agent

**Режим оркестратора (Unified Orchestrator Pattern).** Обработка возражений через LLM с контекстом.
Если возражение не обнаружено → null → fallback на query.

### Booking Agent

**Режим оркестратора (Unified Orchestrator Pattern).** Структурированный сбор данных через LLM.
Включает `tool_calls` для `get_doctor_schedule`. При завершении: `hasBookedConsultation = true`.

---

## 3. Хранилища: RAG Store + Learning Store

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

## 4. Схема БД

### core

- `conversations` — диалоги
- `messages` — сообщения
- `patients` — карточки пациентов
- `services` — услуги с ценами (из 1С, иерархия `parentRef1cId`)
- `accounts` — Instagram Business аккаунты (токены зашифрованы)

### learning

- `response_feedback` — исправления админа
- `kb_suggestions` — предложения в БЗ
- `learning_docs` / `learn_chunks` — авто-сгенерированные документы

---

## 5. Booking Agent

Собирает: услуга, врач, дата/время, имя, телефон, филиал.
Использует `get_doctor_schedule` для сверки расписания.
Эмуляция: логирует данные, `has_booked_consultation = true`.
Готов к интеграции с внешней API.

---

## 6. Фоновые задачи (BullMQ + Redis)

- `process-correction` — извлечение сути исправления, кластеризация
- `generate-kb-suggestions` — сбор pending фидбеков → кластеризация → генерация
- `apply-suggestion` — чанкинг → эмбеддинги → learning store

---

## 7. Admin API

| Endpoint                                        | Описание                |
| ----------------------------------------------- | ----------------------- |
| `GET /api/admin/feedback`                       | Список фидбеков         |
| `POST /api/admin/feedback/:id/correct`          | Исправить ответ         |
| `GET /api/admin/kb-suggestions`                 | Предложения в БЗ        |
| `POST /api/admin/kb-suggestions/:id/approve`    | Подтвердить             |
| `POST /api/admin/learning/generate-suggestions` | Форсировать генерацию   |
| `POST /api/admin/learning/toggle`               | Вкл/выкл Learning Store |
| `POST /api/admin/learning/rollback`             | Очистить Learning Store |

---

## 8. Структура проекта

```
src/
├── agents/
│   ├── orchestrator/
│   │   ├── index.ts       ← итеративный runPipeline
│   │   └── synthesis.ts   ← финальная LLM-сборка ответа
│   ├── conversation/
│   │   └── index.ts
│   ├── rag/
│   │   └── index.ts
│   ├── tool/
│   │   └── index.ts
│   ├── booking/
│   │   └── service.ts
│   ├── objection/
│   │   └── index.ts
│   ├── types.ts           ← AgentResult, Gap, PipelineState
│   └── registry.ts        ← реестр агентов + selectNextAgent
│
├── services/
│   ├── llm/               ← OpenRouter (chat, embeddings)
│   ├── rag/               ← hybrid, intent, prompts, context, grounding
│   └── tools/             ← prices, schedule, definitions
│
├── modules/
│   ├── webhook/           ← Instagram webhook handler
│   ├── auth/              ← Facebook OAuth
│   ├── admin/             ← API endpoints
│   └── health/
│
├── db/
│   └── schema.ts
│
├── app.ts                 ← Elysia bootstrap
├── index.ts               ← точка входа
└── router.ts              ← API router
```

---

## 9. Roadmap

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

## 10. Инфраструктура

- **Runtime:** Bun
- **Framework:** ElysiaJS
- **DB:** PostgreSQL + pgvector
- **ORM:** Drizzle
- **Validation:** Valibot + valibot-env
- **LLM:** OpenRouter (gpt-4o-mini, claude-3.5-sonnet)
- **Queues:** BullMQ + Redis
- **Meta:** Instagram Graph API, Facebook Webhooks

