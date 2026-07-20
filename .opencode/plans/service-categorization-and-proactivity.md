# Plan: Data-driven service categorization + proactive sales behavior

## Context

Two problems identified via `/api/admin/conversations/1`:

1. **Issue 1** — general price queries ("сколько стоят услуги") return a list built
   from 7 hardcoded regex categories in `src/services/tools/prices.ts` (`getBasicPriceList`).
   No clear rationale for why those 7 were chosen. Naive fix ("dump full catalog to LLM")
   is too expensive: a single branch+citizenship combo can have **up to 1641 service rows**
   (e.g. IRM Almaty / kz), which would blow up token cost/latency on every price message.

2. **Issue 2** — the assistant is reactive, not proactive. After greeting/name it just
   waits ("Чем могу помочь?"). No qualifying questions, no CTA loop toward booking. The
   6-step sales script in `prompts.ts` only fires inside the RAG fallback branch, which most
   early conversation turns never reach (fast intents + tool intents bypass it entirely).

## Decisions made with user

- Issue 1: categorize services using a **fixed 7-category taxonomy**, computed **once at
  sync time** via LLM (not per user message), stored in a new `services.category` column.
  Query-time cost becomes a cheap SQL aggregation (~7 rows) + one small LLM call to phrase
  the final answer.
- Taxonomy (fixed, do not let LLM invent new ones):
  1. Консультации врачей
  2. УЗИ и функциональная диагностика
  3. Лабораторные анализы
  4. Генетические исследования
  5. Программы ВРТ
  6. Процедуры и манипуляции
  7. Прочие услуги
- The final phrased answer must explicitly mention the clinic has a wider range of
  services than shown, and ask the user what specifically interests them.
- Issue 2: implement (a) a guiding question appended after greeting/name-acknowledgement,
  and (b) a nudge mechanism that proactively suggests booking after ~3 exchanges if the
  patient hasn't booked yet and hasn't already been nudged.

---

## Issue 1 — Data-driven service categories

### 1. Schema change

`src/db/schema.ts`: add to `services` table:
```ts
category: text('category'),
```

### 2. Taxonomy constant (new file)

`src/constants/service-categories.ts`:
```ts
export const SERVICE_CATEGORIES = [
    'Консультации врачей',
    'УЗИ и функциональная диагностика',
    'Лабораторные анализы',
    'Генетические исследования',
    'Программы ВРТ',
    'Процедуры и манипуляции',
    'Прочие услуги'
] as const

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]

export const DEFAULT_SERVICE_CATEGORY: ServiceCategory = 'Прочие услуги'
```

### 3. Batch LLM classifier (new file)

`src/modules/services/service-classifier.ts`:
- `classifyServiceNames(names: string[]): Promise<Map<string, ServiceCategory>>`
- Before calling LLM: query DB for `SELECT DISTINCT name, category FROM services WHERE category IS NOT NULL`
  to build a cache; only classify names missing from cache (first sync ≈ 550 distinct names,
  subsequent syncs ≈ near 0 new names).
- Batch remaining names in chunks of ~60, call `chat()` from `services/llm/openrouter.ts` with
  `temperature: 0`, `response_format: json_object`, prompt listing the fixed taxonomy and asking
  for `{ "<name>": "<category>", ... }`.
- Validate returned category is one of `SERVICE_CATEGORIES`; fallback to `DEFAULT_SERVICE_CATEGORY`
  if missing/invalid/LLM call fails (log a warning, don't throw — sync must not fail because of this).

### 4. Wire into sync

`src/modules/services/sync.ts` (`fetchAndUpdateServices`):
- After building `allItems` (flat list) and before the upsert loop:
  - Collect `const distinctNames = [...new Set(allItems.map(i => i.name))]`
  - `const categoryMap = await classifyServiceNames(distinctNames)`
- In both insert and update branches, set `category: categoryMap.get(item.name) ?? DEFAULT_SERVICE_CATEGORY`.

### 5. Migration

Run `bun run db:generate` then `bun run db:migrate` (per AGENTS.md — never hand-edit migrations).

### 6. Prices tool rewrite

`src/services/tools/prices.ts`:
- **Remove** `getBasicPriceList()` and its hardcoded `categories` array entirely.
- **Add** `getCategorySummary(branchRef, citizenship)`:
  ```sql
  SELECT DISTINCT ON (category) category, name, price, duration_minutes
  FROM services
  WHERE branch_ref_1c_id = $1 AND citizenship = $2 AND price IS NOT NULL AND price > 0
  ORDER BY category, price ASC
  ```
  (Postgres `DISTINCT ON` — one representative/cheapest row per category, single query,
  ~7 rows max, no separate query per category like before.)
- **Add** `formatCategorySummaryWithLLM(rows, lang)`:
  - Small LLM call (`chat()`), system prompt instructs: act as IRM Clinic consultant, given
    JSON array of `{category, name, price}`, write a warm natural-language answer highlighting
    representative prices per category, explicitly state the clinic offers a wider range of
    services than shown, and ask what specifically interests the user. Must not invent prices
    not present in the data.
  - Language-aware (ru/kk/en) via existing `lang` param pattern used elsewhere in the codebase.
- Update `pricesTool.execute()`:
  - Both places that currently call `getBasicPriceList()` (the general-query branch, and the
    "no exact match but has price markers" fallback) now call `getCategorySummary()` +
    `formatCategorySummaryWithLLM()` instead.
  - Read `lang` from `args.lang` (new arg, default `'ru'`).

### 7. Pass `lang` through to the tool

`src/agents/tool/index.ts` (`handlePriceIntent`): add `toolArgs.lang = lang` before calling
`executeTool('get_prices', toolArgs, updatedPatient)`.

### 8. Manual verification after implementation

- Run sync against a branch with a large catalog, confirm `category` gets populated and
  re-running sync doesn't re-classify unchanged names (check LLM call count/logs).
- `curl -X POST /api/admin/tools/prices` with a general query (no specific service) for a
  branch+citizenship with many rows; confirm response is a short natural-language paragraph,
  not a raw 20-line list, and mentions "more services available".
- Confirm specific-service queries (e.g. "спермограмма") still hit the exact `ilike` search
  path unaffected by this change.

---

## Issue 2 — Proactive sales behavior

### 2a. Guiding question after greeting / name

`src/services/rag/intent.ts`: update templates (ru/kk/en) so that after the assistant knows
(or just learned) the user's name, instead of a bare "Чем могу помочь?" it asks what brought
them to the clinic and briefly signals it can discuss programs/prices/booking:

- `GREETING_NAMED` (returning user, name known)
- `NAME_ACKNOWLEDGE` (right after `provide_name`)
- `GREETING_SHORT` (repeat greeting, no name)

Example (ru): `Приятно познакомиться, {name}! Расскажите, что Вас привело в IRM Clinic? Я могу рассказать о программах лечения, ценах на услуги или записать Вас на консультацию.`

### 2b. Nudge mechanism

**Schema change** — `src/db/schema.ts`, `patients` table: add
```ts
bookingNudgeOffered: boolean('booking_nudge_offered').default(false).notNull(),
```

**Type + accessor updates** — `src/services/rag/patient.ts`:
- Add `bookingNudgeOffered: boolean` to `PatientInfo` interface.
- Include it in `getPatient()` mapping and `ensurePatient()` default object.

**Nudge templates** — `src/services/rag/intent.ts`: add `NUDGE_RESPONSES: Record<'ru'|'kk'|'en', string>`,
e.g. (ru): `Могу я записать Вас на консультацию к врачу-репродуктологу в IRM Clinic? Специалист поможет подобрать программу индивидуально для Вас. Какой день Вам удобен?`

**Orchestrator logic** — `src/agents/orchestrator/index.ts`:
- After producing `finalAnswer` in the `prices` (step 6) and RAG fallback (step 7) branches
  (NOT in objection — that already has its own booking CTA, NOT in fast conversation intents):
  ```
  if (context && patient && !patient.hasBookedConsultation && !patient.bookingNudgeOffered
      && conversation messageCount >= 4)
  {
      finalAnswer += '\n\n' + NUDGE_RESPONSES[effectiveLang]
      await updatePatient(context.senderId, { bookingNudgeOffered: true })
  }
  ```
- Use the message count already available from `getConversationContext`/`incrementMessageCount`
  flow (need to fetch/track count consistently — confirm exact field access, likely
  `ctx.messageCount` or a fresh count after `incrementMessageCount`).

### Migration

Run `bun run db:generate` then `bun run db:migrate` for the `bookingNudgeOffered` column.

### Manual verification after implementation

- Fresh conversation: greet → give name → confirm guiding question appears (not generic
  "Чем могу помочь?").
- Continue asking 2-3 unrelated questions without booking; confirm nudge text appears once,
  and does NOT repeat on every subsequent message.
- Trigger an objection scenario; confirm nudge is not double-appended (objection script
  already offers booking).
- Run existing test suite (`bun test`) — must stay green.

---

## Implementation order

1. Schema migration for both `services.category` and `patients.bookingNudgeOffered` (one
   migration or two — developer's choice, but generate via drizzle, never hand-edit).
2. Issue 1: taxonomy const → classifier module → sync.ts wiring → prices.ts rewrite → tool/index.ts lang passthrough.
3. Issue 2: intent.ts templates (2a + nudge template) → patient.ts type/accessor updates → orchestrator nudge logic.
4. Run `bun run format`, `bun test`, and manual curl checks against `/api/admin/tools/prices`
   and `/api/admin/tools/ask` before considering done.
