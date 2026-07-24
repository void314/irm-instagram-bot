# Предложение по улучшению архитектуры для Booking и Objection

**Дата:** 2026-07-24  
**Цель:** Улучшить гибкость ассистента при работе с интентами `booking` и `objection`

---

## 📊 Текущая архитектура

### Booking Agent

- **Роль:** Полностью автономный агент, ведёт диалог с пользователем
- **Возвращает:** Готовый ответ с CTA
- **Проблема:** При попадании в интент `booking` переключается на другую "личность" (строгий скрипт сбора данных)

### Objection Agent

- **Роль:** Полностью автономный агент, перехватывает инициативу
- **Возвращает:** Готовый ответ с CTA
- **Проблема:** Слишком жёсткий перехват инициативы, не даёт оркестратору управлять диалогом

---

## 🎯 Цели улучшения

1. **Гибкость:** Ассистент должен сохранять единый стиль общения
2. **Контроль:** Оркестратор должен управлять диалогом, а не делегировать его агентам
3. **Структурированность:** Сохранить преимущества структурированного сбора данных

---

## 🚀 Предложение: Unified Orchestrator Pattern

### Концепт

**Booking и Objection не должны быть отдельными агентами.** Они должны быть **режимами работы оркестратора**.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Orchestrator (единая точка управления)        │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Режимы работы:                                          │   │
│  │  • DEFAULT — стандартный pipeline (prices, query)        │   │
│  │  • BOOKING — структурированный сбор данных (по шагам)    │   │
│  │  • OBJECTION — обработка возражений (с контекстом)       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Все режимы используют единый LLM с IRM_BASE + контекстом       │
└─────────────────────────────────────────────────────────────────┘
```

### Реализация

#### 1. Booking Mode

**Текущий подход:**

```typescript
// booking/service.ts
const systemPrompt = buildSystemPrompt(patient, lang) // отдельный промпт
return { content: answer, confidence: 'high', gaps: [] }
```

**Новый подход:**

```typescript
// orchestrator/index.ts
async function handleBookingMode(query: string, state: PipelineState, patient: PatientInfo | null): Promise<AgentResult> {
    // Используем единый промпт IRM_BASE
    const bookingContext = buildBookingContext(state, patient)

    const messages = [{ role: 'system', content: IRM_BASE + bookingContext }, ...state.history, { role: 'user', content: query }]

    const response = await chat(messages, { tools: getToolDefinitions() })

    // Возвращаем данные, а не готовый ответ
    return {
        content: response.content,
        confidence: 'high',
        gaps: [], // booking mode завершает диалог
        updatedPatient: extractBookingData(response.content)
    }
}
```

**Преимущества:**

- ✅ Единый стиль общения (IRM_BASE)
- ✅ Оркестратор управляет диалогом
- ✅ Можно интегрировать в итеративный цикл
- ✅ Можно добавить `gaps` для недостающих данных

#### 2. Objection Mode

**Текущий подход:**

```typescript
// objection/index.ts
const systemPrompt = SYSTEM_PROMPT_OBJECTION + scripts
return { content: answer, confidence: 'high', gaps: [] }
```

**Новый подход:**

```typescript
// orchestrator/index.ts
async function handleObjectionMode(query: string, state: PipelineState, patient: PatientInfo | null): Promise<AgentResult> {
    // Используем единый промпт IRM_BASE
    const objectionContext = buildObjectionContext(query, state, patient)

    const messages = [{ role: 'system', content: IRM_BASE + objectionContext }, ...state.history, { role: 'user', content: query }]

    const response = await chat(messages, { tools: getToolDefinitions() })

    // Возвращаем данные, а не готовый ответ
    return {
        content: response.content,
        confidence: 'high',
        gaps: [], // objection mode завершает диалог
        updatedPatient: extractObjectionData(response.content)
    }
}
```

**Преимущества:**

- ✅ Единый стиль общения (IRM_BASE)
- ✅ Оркестратор управляет диалогом
- ✅ Можно интегрировать в итеративный цикл
- ✅ Можно добавить `gaps` для недостающих данных

---

## 📋 Сравнение подходов

| Критерий                 | Текущий подход                 | Новый подход (Unified Orchestrator) |
| ------------------------ | ------------------------------ | ----------------------------------- |
| **Гибкость**             | ❌ Переключение "личности"     | ✅ Единый стиль (IRM_BASE)          |
| **Контроль**             | ❌ Агенты управляют диалогом   | ✅ Оркестратор управляет диалогом   |
| **Структурированность**  | ✅ Строгий скрипт сбора данных | ✅ Структурированный контекст       |
| **Итеративный цикл**     | ❌ Не участвует                | ✅ Может участвовать                |
| **Централизованный CTA** | ❌ В агентах                   | ✅ В оркестраторе                   |
| **Простота**             | ✅ Разделение ответственности  | ⚠️ Нужна рефакторинг                |

---

## 🛠️ Реализация

### Шаг 1: Создать контекстные функции

```typescript
// orchestrator/context.ts

export function buildBookingContext(state: PipelineState, patient: PatientInfo | null): string {
    const knownFields = [
        patient?.name ? `ФИО: ${patient.name}` : 'ФИО: неизвестно',
        patient?.phone ? `Телефон: ${patient.phone}` : 'Телефон: неизвестно',
        patient?.preferredBranch ? `Филиал: ${patient.preferredBranch}` : 'Филиал: неизвестно',
        patient?.citizenship ? `Гражданство: ${patient.citizenship}` : 'Гражданство: неизвестно'
    ].filter(Boolean)

    return `
=== РЕЖИМ ЗАПИСИ НА КОНСУЛЬТАЦИЮ ===
Собери следующие данные пошагово:
1. Филиал клиники
2. Врач/специалист
3. Дата и время
4. Язык общения
5. ФИО пациента
6. Номер телефона

Уже известно:
${knownFields.join('\n')}

Используй инструменты get_doctor_schedule, get_prices для получения данных.
Когда все данные собраны — сформируй подтверждение записи.
`
}

export function buildObjectionContext(query: string, state: PipelineState, patient: PatientInfo | null): string {
    return `
=== РЕЖИМ ОБРАБОТКИ ВОЗРАЖЕНИЙ ===
Пользователь выразил возражение: "${query}"

Задача:
1. Понять суть возражения
2. Применить соответствующий скрипт
3. Убедить пользователя в преимуществах услуги
4. Предложить решение

Контекст пациента:
${formatPatientContext(patient)}

Используй инструменты get_prices, get_doctor_schedule для подтверждения преимуществ.
`
}
```

### Шаг 2: Обновить AGENT_HANDLERS

```typescript
// orchestrator/index.ts

const AGENT_HANDLERS: Record<AgentName, AgentHandler> = {
    tool: async (query, state, patient, history) => handlePriceIntent(query, patient, state.senderId, state.conversationId, state.lang, history),
    rag: async (query, state, _patient, history, debug) => processRagQuery(query, history, state.patientStr, debug),
    booking: async (query, state, patient, history) => {
        markBookingInProgress(state.conversationId)
        return handleBookingMode(query, state, patient)
    },
    objection: async (query, state, patient, history) => {
        return handleObjectionMode(query, state, patient)
    }
}
```

### Шаг 3: Удалить отдельные агенты

```bash
# Удалить файлы
rm src/agents/booking/service.ts
rm src/agents/objection/index.ts
```

### Шаг 4: Обновить документацию

```markdown
# Архитектура

## Агенты

| Агент            | Задача                                            | Вход                                     | Возвращает    |
| ---------------- | ------------------------------------------------- | ---------------------------------------- | ------------- |
| **Orchestrator** | Интент, диспатч, синтез, персона, CTA, extraction | Любой query                              | Готовый ответ |
| **Conversation** | Приветствия, прощания, имя                        | `intent = greeting/goodbye/provide_name` | Готовый ответ |
| **Tool**         | Цены, расписание, поиск врачей                    | `intent = prices`                        | Данные + gaps |
| **RAG**          | Поиск по БД знаний, описание программ             | `intent = query`                         | Данные + gaps |
| **Objection**    | Обработка возражений (режим оркестратора)         | `intent = objection`                     | Готовый ответ |
| **Booking**      | Запись на приём (режим оркестратора)              | `intent = booking`                       | Готовый ответ |
```

---

## 📊 Результаты

### Преимущества

1. ✅ **Единый стиль общения** — ассистент всегда использует IRM_BASE
2. ✅ **Контроль оркестратора** — он управляет всеми режимами
3. ✅ **Гибкость** — можно легко добавлять новые режимы
4. ✅ **Централизованный CTA** — один источник CTA
5. ✅ **Итеративный цикл** — booking/objection могут участвовать

### Недостатки

1. ⚠️ **Нужна рефакторинг** — перенос логики из агентов в оркестратор
2. ⚠️ **Сложность** — больше логики в оркестраторе
3. ⚠️ **Тестирование** — нужно протестировать все режимы

---

## 🎯 Рекомендация

**Рекомендуется перейти на Unified Orchestrator Pattern**, так как:

1. ✅ Улучшает гибкость ассистента
2. ✅ Сохраняет структурированность сбора данных
3. ✅ Соответствует принципу "только оркестратор формирует финальный ответ"
4. ✅ Упрощает поддержку и расширение

**План реализации:**

1. Создать контекстные функции (`buildBookingContext`, `buildObjectionContext`)
2. Обновить `AGENT_HANDLERS` для использования режимов оркестратора
3. Удалить отдельные агенты (`booking/service.ts`, `objection/index.ts`)
4. Обновить документацию
5. Протестировать все режимы

---

## 🤔 Альтернативы

### Альтернатива 1: Оставить как есть

**Плюсы:**

- ✅ Простота — разделение ответственности
- ✅ Быстрая реализация

**Минусы:**

- ❌ Нарушение принципа архитектуры
- ❌ Переключение "личности"
- ❌ Жёсткий перехват инициативы

### Альтернатива 2: Частичный переход

**Плюсы:**

- ✅ Постепенный переход
- ✅ Можно протестировать по частям

**Минусы:**

- ❌ Двойная логика (старая + новая)
- ❌ Сложность поддержки

---

## 📝 Заключение

**Unified Orchestrator Pattern** — это правильное направление для улучшения архитектуры.

Он сохраняет преимущества структурированного сбора данных, но делает это в рамках единой архитектуры с единым стилем общения.

**Рекомендуется начать с реализации Booking Mode**, так как он более критичен для бизнеса.
