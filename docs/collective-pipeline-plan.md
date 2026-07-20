# Collective Pipeline — реализованная архитектура

## Суть

Итеративный пайплайн, где оркестратор — единственный, кто отвечает пользователю.
Суб-агенты возвращают сырые данные + gap-сигналы (чего не хватает).
Оркестратор в цикле закрывает gaps другими агентами, затем синтезирует ответ с полной IRM_BASE.

**Принципы:**
- Никто, кроме оркестратора, не формирует финальный ответ
- Никто, кроме оркестратора, не содержит CTA, имя, персону
- Суб-агенты — безличные сборщики данных
- max 3 итерации + loop detection по сигнатуре gaps

## Ключевые решения (refined)

| Решение | Суть |
|---------|------|
| **Orchestrator as sole respondent** | Только оркестратор делает LLM-вызов с полной IRM_BASE. Суб-агенты не имеют промпта Aigerim |
| **CTA centralization** | `BOOKING_CTA` только в `synthesis.ts`, НЕ в `prices.ts` или других суб-агентах |
| **AgentResult protocol** | `{ content, confidence, gaps[], updatedPatient? }` |
| **ToolResult.found** | `{ query, answer, found, data?, ... }` — флаг `found` позволяет суб-агенту отличить "нашли, но ответ пуст" от "не нашли" |
| **updatedPatient propagation** | `updatedPatient` из суб-агента → `patient` в PipelineState → передаётся в synthesis → сохраняется |
| **extractPatientData** | Только когда ответ содержательный (не уточняющий вопрос) |
| **maybeAppendNudge** | Только для `intent = query` (RAG), не для `prices` |
| **gaps из Tool agent** | Если цена не найдена → `gaps: [service_composition]` → RAG Agent ищет описание бандла |

## AgentResult

```typescript
interface AgentResult {
  content: string
  confidence: 'high' | 'partial' | 'low'
  gaps: Gap[]
  updatedPatient?: Record<string, unknown>  // пропагируется в state.patient
}

interface Gap {
  type: 'price_info' | 'service_composition' | 'schedule_info'
      | 'doctor_info' | 'general_knowledge' | 'booking_data'
  description: string
  priority: 'critical' | 'nice_to_have'
}
```

## Агенты

| Агент | fillsGaps | Примечание |
|-------|-----------|------------|
| **conversation** | `[]` | Быстрый regex-путь, без LLM |
| **objection** | `[]` | LLM-классификатор возражений |
| **tool** | `[price_info, schedule_info]` | Вызывает `executeTool` |
| **rag** | `[service_composition, general_knowledge, doctor_info]` | Гибридный поиск |
| **booking** | `[booking_data]` | LLM-driven диалог записи |

## Итеративный цикл (runPipeline)

```
1. Быстрые пути (greeting/goodbye/gratitude/provide_name/name_request) → без цикла
2. Intent detection по RAG (LLM)
3. Primary dispatch по intent → AgentResult
4. Есть gaps и critical? → loop:
   selectNextAgent(gaps) → dispatch → merge → check gaps
5. Max 3 итерации + loop detection
6. Synthesis (LLM с полной IRM_BASE):
   - query + accumulated content → ответ с персоной Айгерим
   - BOOKING_CTA в конце
   - extractPatientData (если содержательно)
   - maybeAppendNudge (только для query)
7. wrapRagResponse → RagResponse
```

## Стейты (PipelineState)

```typescript
interface PipelineState {
  query: string; history: string; patient: PatientInfo | null
  patientStr: string; lang: 'ru' | 'kk' | 'en'
  accumulatedContent: string[]; openGaps: Gap[]; closedGaps: Gap[]
  iteration: number; senderId: string; conversationId: bigint
  hasBookedConsultation: boolean
}
```

## Текущие баги (4 шт.)

### 1. BOOKING_CTA в prices.ts
Файл: `src/services/tools/prices.ts`
Проблема: возвращает `BOOKING_CTA` в теле ответа → CTA дублируется или попадает не туда.
Фикс: удалить `BOOKING_CTA` из всех return-путей в prices.ts. CTA только в synthesis.ts.

### 2. synthesis.ts использует короткий промпт, не IRM_BASE
Файл: `src/agents/orchestrator/synthesis.ts`
Проблема: синтезатор работает с урезанным промптом, не знает persona Aigerim.
Фикс: заменить system prompt на полную `IRM_BASE` из `src/services/rag/prompts.ts`.

### 3. updatedPatient не пропагируется
Файл: `src/agents/orchestrator/index.ts`
Проблема: Tool / RAG могут вернуть `updatedPatient`, но он не попадает в `state.patient`.
Фикс: после `dispatchAgent()`: `if (result.updatedPatient) state.patient = { ...state.patient, ...result.updatedPatient }`.

### 4. extractPatientData + maybeAppendNudge без условий
Файл: `src/agents/orchestrator/index.ts`
Проблема: `extractPatientData` вызывается для любых ответов (включая уточняющие вопросы);
`maybeAppendNudge` добавляется для любых intent (не только `query`).
Фикс: `extractPatientData` — только если ответ содержательный (не reasking);
`maybeAppendNudge` — только для `intent.type === 'query'`.

## Структура файлов

```
src/agents/
├── types.ts             ← AgentResult, Gap, PipelineState, AgentDescriptor
├── registry.ts          ← AGENTS[], selectNextAgent
├── orchestrator/
│   ├── index.ts         ← runPipeline (итеративный цикл, 4 bugfix)
│   └── synthesis.ts     ← LLM-синтез с IRM_BASE (bugfix #2)
├── conversation/index.ts
├── rag/index.ts
├── tool/index.ts
├── booking/service.ts
└── objection/index.ts
```
