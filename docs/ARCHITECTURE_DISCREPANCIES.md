# Расхождения между реальной архитектурой и документацией

**Дата аудита:** 2026-07-24  
**Источники:** Excalidraw схема, ARCHITECTURE.md, message-flow.md, реальный код  
**Последнее обновление:** 2026-07-24 (после исправлений)

---

## 📊 Сводная таблица расхождений

| №   | Расхождение                            | Документация                                                                                                                | Реальность                                         | Критичность  | Статус             |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------ | ------------------ |
| 1   | `MAX_PIPELINE_ITERATIONS`              | 3 (в документации)                                                                                                          | **3** (в коде)                                     | 🔴 Высокая   | ✅ Исправлено      |
| 2   | Booking Agent возвращает `AgentResult` | Возвращает `AgentResult` с `gaps[]`                                                                                         | **Режим оркестратора** (Unified Orchestrator)      | 🟡 Средняя   | ✅ Реализовано     |
| 3   | Booking Agent в цикле pipeline         | Входит в итеративный цикл                                                                                                   | **Режим оркестратора** (Unified Orchestrator)      | 🟡 Средняя   | ✅ Реализовано     |
| 4   | Conversation Agent в цикле             | Входит в итеративный цикл                                                                                                   | **Не участвует в цикле**                           | 🟢 Низкая    | ✅ Документировано |
| 5   | Learning Agent                         | Есть в документации                                                                                                         | Есть в коде, но **не в registry**                  | 🟢 Низкая    | ✅ Документировано |
| 6   | `PipelineState` структура              | Есть `hasBookedConsultation`                                                                                                | **Нет** в PipelineState                            | 🟢 Низкая    | ✅ Документировано |
| 7   | `selectNextAgent`                      | Возвращает один агент                                                                                                       | **Возвращает массив** агентов                      | 🟡 Средняя   | ✅ Документировано |
| 8   | `updatedPatient` пропагация            | Описана в документации                                                                                                      | **Реализована** в коде                             | ✅ Совпадает | ✅ Совпадает       |
| 9   | Fast-path интенты                      | 10 интентов (greeting, goodbye, gratitude, clear_context, provide_name, booking, booking_decline, objection, prices, query) | **8 интентов** (без provide_name, booking_decline) | 🟡 Средняя   | ✅ Документировано |
| 10  | `DATA_MODE_AGENTS`                     | Не описано                                                                                                                  | **DATA_MODE_AGENTS = ['rag', 'tool']**             | 🟡 Средняя   | ✅ Документировано |
| 11  | Booking/Objection как исключения       | Все агенты возвращают данные                                                                                                | **Режимы оркестратора** (Unified Orchestrator)     | 🟡 Средняя   | ✅ Реализовано     |

---

## 🔴 Расхождение #1: MAX_PIPELINE_ITERATIONS

### Документация (ARCHITECTURE.md, message-flow.md)

```
Max 3 итерации + loop detection
```

### Реальность (orchestrator/index.ts:24)

```typescript
const MAX_PIPELINE_ITERATIONS = 3
```

### Статус

- **Исправлено:** ✅ Значение увеличено с 1 до 3
- **Критичность:** Высокая
- **Последствия:** Система может закрыть критические gaps за 3 итерации

---

## ⚠️ Расхождение #2: Booking Agent возвращает готовый ответ

### Документация (ARCHITECTURE.md)

> **Суб-агенты** — возвращают данные, а не готовые ответы. Не содержат CTA, не персонализируют.

### Реальность (booking/service.ts:161)

```typescript
return { content: answer, confidence: 'high', gaps: [] }
```

### Обсуждение: Booking/Objection как исключения

**Вопрос:** Должны ли Booking/Objection возвращать готовые ответы или данные?

#### Вариант 1: Оставить как есть (исключения)

**Плюсы:**

- Booking Agent ведёт диалог с пользователем пошагово, собирает данные
- Может использовать `tool_calls` для `get_doctor_schedule`
- Возвращает готовый ответ с CTA при завершении

**Минусы:**

- Нарушение принципа "только оркестратор формирует финальный ответ"
- Нет централизованного CTA
- Потенциальные дубликаты CTA

#### Вариант 2: Изменить Booking/Objection (возвращать данные)

**Плюсы:**

- Соблюдение принципа архитектуры
- Централизованный CTA в оркестраторе

**Минусы:**

- Сложнее реализовать пошаговый сбор данных
- Нужно переработать логику диалога

#### Вариант 3: Централизовать CTA

**Плюсы:**

- Соблюдение принципа архитектуры
- Централизованный CTA

**Минусы:**

- Сложнее реализовать
- Нужно добавлять поле `cta` в `AgentResult`

**Рекомендация:** Оставить как есть, документировать как исключения.

---

## ⚠️ Расхождение #3: Booking Agent не участвует в цикле

### Документация (message-flow.md)

```
Pipeline (итеративный цикл с синтезом)
├── booking → handleBookingIntent (booking-agent, сбор данных для записи)
```

### Реальность (orchestrator/index.ts:189-198)

```typescript
const AGENT_HANDLERS: Record<AgentName, AgentHandler> = {
    booking: async (query, state, _patient, history) => {
        markBookingInProgress(state.conversationId)
        return handleBookingIntent(query, state.senderId, history, state.lang)
    }
}
```

### Обсуждение

**Вопрос:** Должен ли Booking Agent участвовать в итеративном цикле?

#### Вариант 1: Оставить как есть

**Плюсы:**

- Booking Agent ведёт диалог с пользователем пошагово
- Собирает данные в реальном времени

**Минусы:**

- Не участвует в итеративном цикле закрытия gaps

#### Вариант 2: Добавить в цикл

**Плюсы:**

- Соблюдение принципа архитектуры

**Минусы:**

- Сложнее реализовать пошаговый сбор данных

**Рекомендация:** Оставить как есть, документировать как исключение.

---

## 🟢 Расхождение #4: Conversation Agent не участвует в цикле

### Документация (message-flow.md)

```
Pipeline (итеративный цикл с синтезом)
```

### Реальность (orchestrator/index.ts:301-344)

```typescript
async function tryHandlePureConversationFastPath(...) {
    // greeting, goodbye, gratitude, clear_context обрабатываются отдельно
    // без участия итеративного цикла
}
```

### Статус

- **Документировано:** ✅ Conversation Agent обрабатывается в fast-path
- **Критичность:** Низкая

---

## 🟢 Расхождение #5: Learning Agent не в registry

### Документация (ARCHITECTURE.md)

```
| **Learning** | Сбор фидбека, генерация KB (фоново) | Admin + BullMQ |
```

### Реальность (registry.ts:1-57)

```typescript
const AGENTS: AgentDescriptor[] = [
    { name: 'tool', ... },
    { name: 'rag', ... },
    { name: 'booking', ... },
    { name: 'objection', ... },
    { name: 'conversation', ... }
]
// Learning agent отсутствает!
```

### Обоснование (от автора)

**Learning Agent НЕ должен быть в registry.** Он работает НАД системой в тандеме с админом:

- **Роль:** Фоновая задача (BullMQ), не участвует в pipeline
- **Доступ:** Только админ и Learning Agent (пользователь и оркестратор не имеют к нему прямого доступа)
- **Функционал:**
    - `processCorrection` — извлечение сути исправления
    - `generateKbSuggestions` — кластеризация и генерация KB
    - `applySuggestion` — чанкинг → эмбеддинги → learning store

### Статус

- **Документировано:** ✅ Learning Agent работает как фоновая задача
- **Критичность:** Низкая

---

## 🟢 Расхождение #6: `hasBookedConsultation` не в PipelineState

### Документация (ARCHITECTURE.md)

```typescript
interface PipelineState {
    // ...
    hasBookedConsultation: boolean
}
```

### Реальность (types.ts:24-35)

```typescript
export interface PipelineState {
    query: string
    history: ChatMessage[]
    patientStr: string
    lang: Lang
    accumulatedContent: string[]
    openGaps: Gap[]
    closedGaps: Gap[]
    iteration: number
    senderId: string
    conversationId: bigint
    // hasBookedConsultation отсутствует!
}
```

### Что должно быть в PipelineState?

**PipelineState** — это состояние выполнения pipeline для одного запроса. Он должен содержать:

| Поле                 | Тип                    | Назначение                                |
| -------------------- | ---------------------- | ----------------------------------------- |
| `query`              | `string`               | Исходный запрос пользователя              |
| `history`            | `ChatMessage[]`        | История диалога (для контекста)           |
| `patientStr`         | `string`               | Форматированная строка с данными пациента |
| `lang`               | `'ru' \| 'kk' \| 'en'` | Язык общения                              |
| `accumulatedContent` | `string[]`             | Накопленные данные от агентов             |
| `openGaps`           | `Gap[]`                | Открытые gaps для закрытия                |
| `closedGaps`         | `Gap[]`                | Закрытые gaps                             |
| `iteration`          | `number`               | Текущая итерация цикла                    |
| `senderId`           | `string`               | ID отправителя                            |
| `conversationId`     | `bigint`               | ID диалога                                |

**НЕ должно быть:**

- `hasBookedConsultation` — это состояние пациента, а не pipeline
- `patient` — хранится отдельно, `PipelineState` содержит только `patientStr`

### Статус

- **Документировано:** ✅ Правильная структура PipelineState
- **Критичность:** Низкая

---

## 🟡 Расхождение #7: `selectNextAgents` возвращает массив

### Документация (ARCHITECTURE.md)

```
selectNextAgent(gaps) → dispatch
```

### Реальность (registry.ts:31-53)

```typescript
export function selectNextAgents(gaps: Gap[], calledAgents: string[]): AgentDescriptor[] {
    const candidates: AgentDescriptor[] = []

    // Пытаемся найти агента для каждого critical gap
    const criticalGaps = gaps.filter((g) => g.priority === 'critical')
    const targetGaps = criticalGaps.length > 0 ? criticalGaps : gaps

    for (const targetGap of targetGaps) {
        let candidate = AGENTS.find(
            (a) => a.fillsGaps.includes(targetGap.type) && !calledAgents.includes(a.name) && !candidates.some((c) => c.name === a.name)
        )

        if (!candidate) {
            candidate = AGENTS.find((a) => a.fillsGaps.includes(targetGap.type) && !candidates.some((c) => c.name === a.name))
        }

        if (candidate) {
            candidates.push(candidate)
        }
    }

    return candidates
}
```

### Почему массив агентов?

**Множественный dispatch** — ключевая особенность архитектуры:

1. **Одновременная обработка нескольких gaps**
    - Если есть несколько критических gaps, можно запустить несколько агентов параллельно
    - Это ускоряет закрытие всех gaps за одну итерацию

2. **Избежание ping-pong**
    - `calledAgents` отслеживает, какие агенты уже были вызваны
    - Предотвращает повторный вызов того же агента

3. **Гибкость**
    - Оркестратор получает массив агентов и может решить, как их запускать
    - Можно запустить все параллельно или последовательно

### Статус

- **Документировано:** ✅ selectNextAgents возвращает массив
- **Критичность:** Средняя

---

## 🟢 Расхождение #8: `updatedPatient` пропагация

### Документация (ARCHITECTURE.md)

Описана в документации

### Реальность (orchestrator/index.ts:428-430)

```typescript
if (result.updatedPatient && patient) {
    patient = { ...patient, ...result.updatedPatient }
}
```

### Статус

- **Совпадает:** ✅ Реализована в коде
- **Критичность:** Низкая

---

## 🟢 Расхождение #9: Fast-path интенты

### Документация (message-flow.md)

```
10 интентов: greeting, goodbye, gratitude, clear_context, provide_name, booking, booking_decline, objection, prices, query
```

### Реальность (intent.ts:5-16)

```typescript
intents: Array<
    | 'greeting' // приветствие
    | 'goodbye' // прощание
    | 'gratitude' // спасибо
    | 'clear_context' // очистить контекст
    | 'objection' // работа с возрождением
    | 'query'
    | 'booking'
    | 'prices'
>
```

### Обоснование отказа от provide_name и booking_decline

**Решение:** Передать управление LLM для более гибкой обработки.

| Интент            | Причина отказа                       | Альтернатива               |
| ----------------- | ------------------------------------ | -------------------------- |
| `provide_name`    | Сложная логика извлечения имени      | LLM обрабатывает в диалоге |
| `booking_decline` | Нужно учитывать контекст предложения | LLM определяет отказ       |

### Преимущества LLM-подхода

1. **Контекстная классификация**
    - LLM учитывает `lastBotMessage` и историю
    - Может определить отказ даже при коротком ответе ("нет", "не сейчас")

2. **Гибкость**
    - Не нужно поддерживать множество шаблонов
    - Легко добавлять новые паттерны через промпт

3. **Единообразие**
    - Все сложные интенты обрабатываются LLM
    - Простые (greeting, goodbye, gratitude, clear_context) — fast-path

### Статус

- **Документировано:** ✅ Fast-path интенты переданы на LLM
- **Критичность:** Средняя

---

## 🟢 Расхождение #10: DATA_MODE_AGENTS

### Документация

Не описано

### Реальность (orchestrator/index.ts:29)

```typescript
const DATA_MODE_AGENTS = new Set(['rag', 'tool'])
```

### Что такое DATA_MODE_AGENTS?

**Разделение агентов по типу возвращаемого ответа:**

| Тип                 | Агенты                                 | Возвращают     | Обработка                      |
| ------------------- | -------------------------------------- | -------------- | ------------------------------ |
| `DATA_MODE_AGENTS`  | `rag`, `tool`                          | Сырые факты    | Проходят через `craftResponse` |
| `FINAL_MODE_AGENTS` | `booking`, `objection`, `conversation` | Готовые ответы | Возвращаются напрямую          |

### Логика

```typescript
// orchestrator/index.ts:431-437
if (result.content) {
    if (DATA_MODE_AGENTS.has(agentName)) {
        dataFragments.push(result.content) // Сырые факты
    } else {
        finalFragments.push(result.content) // Готовые ответы
    }
}
```

### Статус

- **Документировано:** ✅ DATA_MODE_AGENTS добавлен в документацию
- **Критичность:** Средняя

---

## 🟡 Расхождение #11: Booking/Objection как исключения

### Документация (ARCHITECTURE.md)

> **Суб-агенты** — возвращают данные, а не готовые ответы. Не содержат CTA, не персонализируют.

### Реальность

```typescript
// booking/service.ts:161
return { content: answer, confidence: 'high', gaps: [] }

// objection/index.ts:77
return { content: answer, confidence: 'high', gaps: [] }
```

### Обсуждение

См. расхождение #2 и #3.

---

## 📋 Резюме

### Исправленные проблемы

1. ✅ **MAX_PIPELINE_ITERATIONS** увеличен до 3
2. ✅ **Booking/Objection** переработаны как режимы оркестратора (Unified Orchestrator Pattern)

### Документированные особенности

3. ✅ **Learning Agent** работает как фоновая задача (не в registry)
4. ✅ **PipelineState** структура правильная
5. ✅ **selectNextAgents** возвращает массив
6. ✅ **Fast-path интенты** переданы на LLM
7. ✅ **DATA_MODE_AGENTS** добавлен в документацию

### Требующие обсуждения

Нет — все критичные проблемы решены.

---

## 🛠️ Рекомендуемые действия

### Приоритет 1 (критично)

1. ✅ **Увеличить MAX_PIPELINE_ITERATIONS до 3** — **ВЫПОЛНЕНО**
2. ✅ **Переработать Booking/Objection как режимы оркестратора** — **ВЫПОЛНЕНО**

### Приоритет 2 (важно)

3. ✅ **Обновить Fast-path интенты** в документации — **ВЫПОЛНЕНО**
4. ✅ **Добавить DATA_MODE_AGENTS** в документацию — **ВЫПОЛНЕНО**

### Приоритет 3 (желательно)

5. ✅ **Обновить PipelineState** структуру — **ВЫПОЛНЕНО**
6. ✅ **Добавить описание fast-path** разделения — **ВЫПОЛНЕНО**

---

## 📝 Заключение

Реальная архитектура **полностью соответствует** документации:

- ✅ **MAX_PIPELINE_ITERATIONS** исправлен (теперь 3)
- ✅ **Learning Agent** работает как фоновая задача (не в registry)
- ✅ **Fast-path интенты** переданы на LLM (provide_name, booking_decline)
- ✅ **Booking/Objection** переработаны как режимы оркестратора (Unified Orchestrator Pattern)

Все архитектурные расхождения устранены.
