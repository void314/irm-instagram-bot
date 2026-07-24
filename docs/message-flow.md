# Архитектура обработки сообщений

## Общий поток

```
Instagram DM
     │
     ▼
Webhook (src/modules/webhook/instagram/service.ts)
  ├─ сохраняет входящее сообщение в messages (БД)
  └─ вызывает runPipeline(question, { conversationId, senderId })
```

`runPipeline` — центральная функция оркестратора (`src/agents/orchestrator/index.ts`).
Обработка делится на **два независимых пути**: Fast-path и Pipeline.

---

## 1. Fast-path (возврат без итеративного цикла)

Простые интенты, не требующие поиска данных.
Ответ формируется из шаблонов или одним прямым вызовом суб-агента.

```
detectIntentLLM (LLM-классификатор)
     │
     ├── greeting         → handleConversationIntent → getFastIntentResponse
     │                       шаблоны из intent.ts:
     │                       │ isFirstMessage=true  + имя  → GREETING_NAMED
     │                       │ isFirstMessage=true  − имя  → GREETING_FULL
     │                       │ isFirstMessage=false + имя  → GREETING_CONTINUATION
     │                       │ isFirstMessage=false − имя  → GREETING_SHORT
     │                       + appendNameQuestion (если имя неизвестно)
     │
     ├── goodbye          → handleConversationIntent → GOODBYE_RESPONSES / GOODBYE_RESPONSES_NAMED
     │
     ├── gratitude        → handleConversationIntent → GRATITUDE_RESPONSES / GRATITUDE_RESPONSES_NAMED
     │
     ├── clear_context    → handleConversationIntent → CLEAR_CONTEXT_RESPONSES + сброс summary/metadata в БД
     │
     ├── provide_name     → handleConversationIntent
     │                       extractNameCandidate → сохранить имя в БД → getNameAcknowledgeResponse
     │
     ├── booking          → handleBookingIntent (booking-agent, сбор данных для записи)
     │
     ├── booking_decline  → BOOKING_DECLINE_RESPONSE + bookingNudgeOffered=true
     │
     └── objection        → checkAndHandleObjection (скрипты возражений)
                             если objection не обнаружен → null → падает в Pipeline как 'query'
```

Все Fast-path возвращают `RagResponse` напрямую, **Pipeline не выполняется**.

---

## 2. Pipeline (итеративный цикл с синтезом)

Для интентов, где нужны реальные данные: `prices`, `query` (и `objection` если fast-path вернул null).

```
prices / query
     │
     ▼
mapIntentToAgentName
  prices → 'tool'
  query  → 'rag'
     │
     ▼
dispatchAgent(primaryAgent)
     │
     │  результат: AgentResult { content, confidence, gaps[], updatedPatient? }
     │
     ├── confidence='low' + gaps с priority='critical'
     │       → итеративный цикл:
     │           selectNextAgent(openGaps, calledAgents) → dispatchAgent
     │           MAX_ITERATIONS = 3 + loop detection
     │           выход: confidence='high' + gaps=[]
     │
     └── confidence='high' / нет critical gaps
             → выход из цикла
     │
     ▼
accumulatedContent [одна или несколько частей от агентов]
     │
     ├── 1 часть И короткая И заканчивается на '?'
     │     → finalAnswer = сырой ответ агента (уточняющий вопрос)
     │
     └── иначе
           → synthesizeFinalAnswer(query, accumulatedContent, lang, patientStr, history)
                │
                ▼
           LLM с IRM_BASE + patientContext + история + данные агентов
                │
                ▼
           связный естественный ответ
     │
     ▼
Пост-обработка:
  ├─ personalizeAnswer       — префикс «Имя, » если LLM не использовала имя
  ├─ appendNameQuestion      — «Как к Вам обращаться?» если имя неизвестно
  ├─ PRICES_BOOKING_CTA      — CTA для prices (только если primaryConfidence ≠ 'low')
  ├─ maybeAppendNudge        — nudge на запись после NUDGE_MESSAGE_THRESHOLD сообщений
  └─ extractPatientData      — извлечь имя/гражданство/филиал из диалога
```

---

## 3. Детекция интента

LLM-классификатор (`detectIntentLLM`) получает:
- Сообщение пользователя
- `lastBotMessage` (последний ответ бота) — для контекстной классификации

Промпт содержит:
- Список всех 10 интентов с описаниями
- Правило: если `lastBotMessage` — вопрос, а ответ пользователя — короткий ответ на него,
  классифицировать по теме вопроса бота (не как `query`)

---

## 4. Синтез ответа (`synthesizeFinalAnswer`)

Вызывается для multi-result или для single-result с фактами (не уточняющий вопрос).

System prompt:
1. `IRM_BASE` — персона Айгерим, правила общения
2. `patientContext` — известные данные пациента (имя, гражданство, филиал)
3. `Сегодня: {дата}`
4. `История диалога`
5. Данные от агентов: `[Источник 1]: ...`

Модель: `openai/gpt-4o-mini`, temperature: 0.3, max_tokens: 600.

---

## 5. Визуальная схема

```
                    ┌─────────────────────────────┐
                    │     Instagram DM / Admin      │
                    └─────────────┬───────────────┘
                                  │
                    ┌─────────────▼───────────────┐
                    │        detectIntentLLM       │
                    │     (lastBotMessage + query) │
                    └─────────────┬───────────────┘
                                  │
                    ┌─────────────▼───────────────┐
                    │     messageCount === 0 ?     │
                    │     → isFirstMessage         │
                    └─────────────────────────────┘
                                  │
                    ┌─────────────▼───────────────┐
                    │      ┌──────┴──────┐         │
                    │      │             │         │
                    │ greeting/     prices/       │
                    │ goodbye/      query/        │
                    │ gratitude/    objection     │
                    │ clear_context/               │
                    │ provide_name/                │
                    │ booking/                     │
                    │ booking_decline              │
                    │      │             │         │
                    │  ┌───▼───┐    ┌───▼───┐     │
                    │  │ Fast │    │Pipeline│     │
                    │  │ Path │    │ (loop) │     │
                    │  └───┬───┘    └───┬───┘     │
                    │      │             │         │
                    │  ┌───▼─────────────▼───┐    │
                    │  │   RagResponse        │    │
                    └──┴─────────────────────┘    │
                                  │
                    ┌─────────────▼───────────────┐
                    │     Сохранение в БД          │
                    │     Отправка в Instagram     │
                    └─────────────────────────────┘
```

---

## См. также

- [Архитектура](ARCHITECTURE.md) — подробное описание архитектуры системы
- [README](README.md) — обзор проекта и инфраструктура
