# IRM Instagram AI Assistant — Архитектурный план

## Цель

Эволюция проекта в multi-agent CRM систему для комплексного обслуживания клиентов в Instagram с поддержкой масштабирования и механикой автоматического обучения.

---

## 1. Общая архитектура

```
Instagram DM ──► Webhook ──► Orchestrator Agent
                                    │
                    ┌───────────────┼──────────────────┐
                    ▼               ▼                    ▼
           ┌────────────┐  ┌────────────┐  ┌──────────────────┐
           │ Conversation│  │  RAG       │  │    Tool Agent    │
           │   Agent     │  │  Agent     │  │ (prices, doctors,│
           │ (greeting,  │  │ (knowledge)│  │  schedule)       │
           │  chitchat)  │  └────────────┘  └────────┬─────────┘
           └────────────┘                            │
                                      ┌──────────────┘
                                      ▼
                             ┌────────────────┐
                             │ Objection Agent│
                             │  (возражения)  │
                             └────────────────┘

                                      ▼
                             ┌────────────────┐
                             │  Booking Agent │
                             │  (запись,      │
                             │   эмуляция)    │
                             └────────────────┘

После ответа ──► Learning Agent (фоново)
                     ├── Сохранить фидбек
                     ├── Кластеризация исправлений
                     └── Генерация KB suggestions
```

### 1.1 Оркестратор + суб-агенты (гибрид)

**Orchestrator Agent** — единая точка входа. Определяет интент (LLM + regex), ведет общий контекст беседы, выбирает суб-агента, выполняет пост-обработку (patient info extraction, суммаризация).

**Суб-агенты:**

| Агент                  | Задача                                             | Вход                                  |
| ---------------------- | -------------------------------------------------- | ------------------------------------- |
| **Conversation Agent** | Приветствия, прощания, благодарности, светский чат | `intent = greeting/goodbye/gratitude` |
| **RAG Agent**          | Поиск по БД знаний, ответы на вопросы о клинике    | `intent = query && has_knowledge`     |
| **Tool Agent**         | Цены, расписание, поиск врачей                     | `intent = price/schedule/doctor`      |
| **Booking Agent**      | Запись на прием, сбор данных, подтверждение        | `intent = booking`                    |
| **Objection Agent**    | Обработка возражений                               | `intent = objection`                  |
| **Learning Agent**     | Сбор фидбека, генерация предложений в БЗ           | фоново + из админки                   |

---

## 2. Хранилища: RAG Store (ручной) и Learning Store (авто)

Система использует **два раздельных pgvector-хранилища** с разными весами при поиске.

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

### Сравнение хранилищ

| Аспект              | RAG Store               | Learning Store                   |
| ------------------- | ----------------------- | -------------------------------- |
| **Таблицы**         | `documents` → `chunks`  | `learning_docs` → `learn_chunks` |
| **source**          | `manual`, `admin`       | `learning`                       |
| **Кто наполняет**   | Админ вручную, импорт   | Learning agent (авто-генерация)  |
| **Вес в поиске**    | 1.0 (высокий приоритет) | 0.5 (низкий приоритет)           |
| **Можно отключить** | Нет (базовая БЗ)        | Да (toggle в админке)            |
| **Очистка**         | Только руками           | Можно bulk-delete                |

### hybridSearch v2

При поиске опрашиваются оба хранилища и результаты объединяются:

```
results = []
results += ragSearch(query, top_k=5)     # вес 1.0
results += learnSearch(query, top_k=3)   # вес 0.5
# объединение → дедупликация → сортировка по скорингу
```

---

## 3. Automatic Learning System

### Уровень A: Feedback Collection

```
Админ в панели:
  ┌──────────────────────────────────┐
  │ Вопрос: "Сколько стоит...?"       │
  │ Ответ ИИ: "Цена 5000тг"          │ ← можно править inline
  │ [✏ Править] [👍 OK] [👎 Bad]     │
  └──────────────────────────────────┘

Исправление → сохраняется в response_feedback
```

### Уровень B: Response Override

При повторном похожем запросе:

- Если есть `response_feedback` со статусом `applied` → Learning Store уже содержит исправление
- Если `pending` → подмешиваем `corrected_response` в контекст промпта

### Уровень C: KB Suggestion Pipeline

```
BullMQ cron (еженощно или по триггеру):
  1. Собрать response_feedback со статусом pending (N+)
  2. Семантическая кластеризация по embedding similarity
  3. Для каждого кластера: LLM → формулирует документ
  4. Сохранить как kb_suggestion (status: pending)

Админ видит:
  📄 Предложение #42: "Цены на лазерную эпиляцию"
  [Редактировать] [Добавить в Learning Store] [Отклонить]

При подтверждении:
  → Создать документ в learning_docs
  → Чанкинг → эмбеддинги → learn_chunks
  → Статус → applied
```

### Уровень D: Rollback Learning

```
POST /api/admin/learning/rollback
  → DELETE FROM learn_chunks
  → DELETE FROM learning_docs
  → RAG Store работает как раньше, ничего не сломано
```

---

## 4. Схема БД (новые таблицы)

### response_feedback

| Колонка            | Тип       | Описание                     |
| ------------------ | --------- | ---------------------------- |
| id                 | bigint PK |                              |
| response_id        | text      | UUID ответа                  |
| conversation_id    | bigint FK |                              |
| session_id         | text      | Группа исправлений           |
| query              | text      | Исходный вопрос юзера        |
| original_response  | text      | Что сказал ИИ                |
| corrected_response | text      | Что исправил админ           |
| correction_reason  | text      | Почему                       |
| source             | text      | admin / auto                 |
| status             | text      | pending / applied / rejected |
| metadata           | jsonb     | Модель, chunks, агент        |
| created_at         | timestamp |                              |

### kb_suggestions

| Колонка             | Тип                       | Описание                                |
| ------------------- | ------------------------- | --------------------------------------- |
| id                  | bigint PK                 |                                         |
| title               | text                      | Заголовок документа                     |
| content             | text                      | Сгенерированный LLM контент             |
| source_feedback_ids | jsonb                     | Ссылки на исходные исправления          |
| status              | text                      | pending / approved / rejected / applied |
| target_document_id  | bigint FK → learning_docs |                                         |
| confidence          | float                     | 0–1                                     |
| generated_by        | text                      | Модель                                  |
| reviewed_at         | timestamp                 |                                         |
| created_at          | timestamp                 |                                         |

### learning_docs

| Колонка             | Тип                     | Описание                   |
| ------------------- | ----------------------- | -------------------------- |
| id                  | bigint PK               |                            |
| title               | text NOT NULL           |                            |
| source              | text DEFAULT 'learning' |                            |
| source_feedback_ids | jsonb                   | Какие исправления породили |
| confidence          | float                   | 0–1 уверенность генерации  |
| metadata            | jsonb                   |                            |
| created_at          | timestamp               |                            |

### learn_chunks

| Колонка     | Тип                       | Описание             |
| ----------- | ------------------------- | -------------------- |
| id          | bigint PK                 |                      |
| document_id | bigint FK → learning_docs | Cascade delete       |
| index       | int NOT NULL              | Порядок чанка        |
| text        | text NOT NULL             |                      |
| embedding   | vector(3072)              |                      |
| tsv         | tsvector                  | Полнотекстовый поиск |
| metadata    | jsonb                     |                      |
| created_at  | timestamp                 |                      |

Структура `learning_docs`/`learn_chunks` идентична `documents`/`chunks`. Отличие — семантика и вес при поиске.

---

## 5. Booking Agent

При интенте `booking`:

1. Собрать: услуга, врач, дата/время, имя, телефон
2. Использовать Tool Agent для получения цен, врачей, расписания
3. Сформировать объект записи
4. Эмуляция: залогировать полные данные, `has_booked_consultation = true`
5. Ответ юзеру: "Вы записаны! (тестовый режим)"

Готов к интеграции с реальной внешней системой — замена одного вызова.

---

## 6. Фоновые задачи (BullMQ + Redis)

- **process-correction**: извлечение сути исправления (LLM), поиск похожих (embedding), группировка
- **generate-kb-suggestions**: сбор pending фидбеков, кластеризация, генерация документов (еженощно или по триггеру)
- **apply-suggestion**: чанкинг, эмбеддинги, запись в learning store

---

## 7. Admin API (learning endpoints)

| Endpoint                                        | Описание                             |
| ----------------------------------------------- | ------------------------------------ |
| `GET /api/admin/feedback`                       | Список фидбеков (пагинация, фильтры) |
| `POST /api/admin/feedback/:id/correct`          | Исправить ответ                      |
| `POST /api/admin/feedback/batch-cluster`        | Запустить кластеризацию              |
| `GET /api/admin/kb-suggestions`                 | Список предложений в БЗ              |
| `POST /api/admin/kb-suggestions/:id/approve`    | Подтвердить                          |
| `POST /api/admin/kb-suggestions/:id/reject`     | Отклонить                            |
| `GET /api/admin/learning-stats`                 | Статистика дашборда                  |
| `POST /api/admin/learning/generate-suggestions` | Форсировать генерацию                |
| `POST /api/admin/learning/toggle`               | Вкл/выкл Learning Store              |
| `POST /api/admin/learning/rollback`             | Очистить Learning Store              |

**learning-stats возвращает:**

```json
{
    "totalCorrections": 142,
    "pendingFeedback": 23,
    "pendingSuggestions": 5,
    "appliedDocuments": 12,
    "ragChunksCount": 450,
    "learnChunksCount": 38,
    "learningEnabled": true,
    "topicsHeatmap": [
        { "topic": "цены", "count": 34 },
        { "topic": "лазерная эпиляция", "count": 18 }
    ],
    "dailyTrend": [{ "date": "2026-07-01", "corrections": 5, "approved": 2 }]
}
```

---

## 8. Структура проекта

```
src/
├── agents/
│   ├── orchestrator/
│   │   └── index.ts           ← runPipeline v2
│   ├── conversation/
│   │   ├── index.ts
│   │   └── prompts.ts
│   ├── rag/
│   │   ├── index.ts
│   │   └── service.ts
│   ├── tool/
│   │   ├── index.ts
│   │   └── service.ts
│   ├── booking/
│   │   ├── index.ts
│   │   ├── service.ts         ← эмуляция
│   │   └── prompts.ts
│   ├── objection/
│   │   ├── index.ts
│   │   └── prompts.ts
│   └── learning/
│       ├── index.ts
│       ├── service.ts         ← feedback, suggestion
│       ├── scheduler.ts       ← BullMQ worker
│       ├── cluster.ts         ← semantic clustering
│       └── prompts.ts
│
├── lib/
│   └── queue.ts               ← BullMQ setup
│
├── db/
│   └── schema.ts              ← + response_feedback, kb_suggestions, learning_docs, learn_chunks
│
├── modules/
│   └── admin/
│       └── index.ts           ← + learning endpoints
│
├── services/                   ← существующий код (постепенная миграция)
│   ├── rag/                   → agents/rag/
│   └── tools/                 → agents/tool/
│
└── ...остальное без изменений
```

---

## 9. Roadmap

### Phase 1 — Foundation

- Redis + BullMQ в docker-compose
- Реструктуризация в агенты (src/agents/)
- Booking Agent (эмуляция)
- Новые таблицы → db:generate → db:migrate
- Admin endpoints: CRUD feedback

### Phase 2 — Learning Engine

- BullMQ jobs: process-correction
- BullMQ cron: generate-kb-suggestions
- Response override в оркестраторе
- Admin endpoints: KB suggestions + Learning Store toggle/rollback

### Phase 3 — Dashboard

- Learning dashboard stats endpoint

### Phase 4 — Booking Integration

- Замена эмуляции на реальную внешнюю API

---

## 10. Инфраструктура

- **Redis** — через docker-compose (новый сервис)
- **BullMQ** — пакеты `bullmq`, `ioredis`
- **Очереди**: `corrections`, `suggestions`, `embeddings`
- **Схема** — Drizzle ORM + pgvector

