import { and, eq, inArray } from 'drizzle-orm'

import { db } from '../../db/client'
import { kbSuggestions, learnChunks, learningDocs, responseFeedback } from '../../db/schema'
import { chat, generateEmbedding } from '../../services/llm/openrouter'
import { log } from '../../services/logger'
import { chunkText } from '../../services/rag/chunker'

// Prompts
const EXTRACT_CORE_PROMPT = `Ты - AI-аналитик базы знаний клиники.
Администратор исправил ответ ИИ на вопрос пользователя.
Тебе нужно сформулировать краткую суть исправления (факт, который нужно запомнить) в одном-двух предложениях.
Без воды, только суть.
`

const GENERATE_KB_DOC_PROMPT = `Ты - AI-редактор базы знаний клиники.
Ниже приведены несколько исправлений, сделанных администратором на одну и ту же тему.
Объедини их в единый связный документ (статью) для базы знаний.
Документ должен быть написан в информативном стиле, готовом для использования ИИ-ассистентом.
Обязательно включи все важные факты, цены, правила или уточнения из исправлений.
`

/**
 * Extracts the core meaning of a correction and assigns a session_id based on semantic similarity (or LLM grouping).
 */
export async function processCorrection(feedbackId: bigint) {
    const feedback = await db
        .select()
        .from(responseFeedback)
        .where(eq(responseFeedback.id, feedbackId))
        .then((r) => r[0])
    if (!feedback) return

    // 1. Extract core meaning (we can save this to metadata if we want, or use it to generate session_id)
    const extractionResponse = await chat([
        { role: 'system', content: EXTRACT_CORE_PROMPT },
        {
            role: 'user',
            content: `Вопрос пользователя: ${feedback.query}\nОтвет ИИ: ${feedback.originalResponse}\nИсправление админа: ${feedback.correctedResponse}\nПричина (если есть): ${feedback.correctionReason || 'нет'}`
        }
    ])

    const coreFact = extractionResponse.content
    log.info({ module: 'learning', feedbackId: Number(feedbackId) }, 'Extracted core fact: ' + coreFact)

    // A simple clustering: generate an embedding for the core fact and find a similar pending feedback
    // Since we don't have an embedding column on response_feedback, we'll do a simpler approach:
    // We can just group by LLM topic extraction, or for now, treat every feedback as its own cluster
    // and wait for batch generation, OR we can generate a short topic name via LLM.

    const topicResponse = await chat([
        {
            role: 'system',
            content:
                'Выдели основную тему этого факта в 2-3 словах. Например: "Цены лазерная эпиляция", "График работы Алматы". Только тема, без кавычек.'
        },
        { role: 'user', content: coreFact }
    ])

    const sessionId = topicResponse.content.trim().toLowerCase()

    await db
        .update(responseFeedback)
        .set({
            sessionId,
            metadata: { ...((feedback.metadata as object) || {}), coreFact }
        })
        .where(eq(responseFeedback.id, feedbackId))

    log.info({ module: 'learning', feedbackId: Number(feedbackId), sessionId }, 'Correction processed')
}

/**
 * Groups pending feedbacks by sessionId and generates KB suggestions.
 */
export async function generateKbSuggestions() {
    log.info({ module: 'learning' }, 'Starting generateKbSuggestions job')

    // Find all pending feedback
    const pending = await db.select().from(responseFeedback).where(eq(responseFeedback.status, 'pending'))

    if (pending.length === 0) {
        log.info({ module: 'learning' }, 'No pending feedback to process')
        return { generated: 0 }
    }

    // Group by sessionId
    const groups: Record<string, typeof pending> = {}
    for (const f of pending) {
        if (!f.sessionId) continue
        if (!groups[f.sessionId]) groups[f.sessionId] = []
        groups[f.sessionId].push(f)
    }

    let generatedCount = 0

    for (const [topic, items] of Object.entries(groups)) {
        // If we have enough items in a group, or we just generate for any pending item (for testing let's do any)
        const combinedContent = items
            .map((i, idx) => `[${idx + 1}] Вопрос: ${i.query}\nИсправление: ${i.correctedResponse}`)
            .join('\n\n')

        const docResponse = await chat([
            { role: 'system', content: GENERATE_KB_DOC_PROMPT },
            { role: 'user', content: combinedContent }
        ])

        const suggestionIds = await db
            .insert(kbSuggestions)
            .values({
                title: `Новое знание: ${topic}`,
                content: docResponse.content,
                sourceFeedbackIds: items.map((i) => Number(i.id)),
                status: 'pending',
                generatedBy: 'llm',
                confidence: 0.9 // placeholder
            })
            .returning({ id: kbSuggestions.id })

        log.info(
            { module: 'learning', topic, suggestionId: Number(suggestionIds[0].id) },
            'Generated KB suggestion'
        )
        generatedCount++
    }

    return { generated: generatedCount }
}

/**
 * Applies a KB suggestion: creates learning_docs and learn_chunks.
 */
export async function applySuggestion(suggestionId: bigint) {
    const suggestion = await db
        .select()
        .from(kbSuggestions)
        .where(eq(kbSuggestions.id, suggestionId))
        .then((r) => r[0])
    if (!suggestion || suggestion.status !== 'approved') return

    // 1. Create document
    const [doc] = await db
        .insert(learningDocs)
        .values({
            title: suggestion.title,
            sourceFeedbackIds: suggestion.sourceFeedbackIds,
            confidence: suggestion.confidence
        })
        .returning()

    // 2. Chunk and embed
    const chunksData = chunkText(suggestion.content)

    for (const [idx, chunk] of chunksData.entries()) {
        const embedding = await generateEmbedding(chunk.content)
        await db.insert(learnChunks).values({
            documentId: doc.id,
            index: idx,
            text: chunk.content,
            embedding: embedding
        })
    }

    // 3. Mark suggestion as applied
    await db
        .update(kbSuggestions)
        .set({ status: 'applied', targetDocumentId: doc.id })
        .where(eq(kbSuggestions.id, suggestionId))

    // 4. Mark source feedbacks as applied
    if (suggestion.sourceFeedbackIds && suggestion.sourceFeedbackIds.length > 0) {
        await db
            .update(responseFeedback)
            .set({ status: 'applied' })
            .where(
                inArray(
                    responseFeedback.id,
                    suggestion.sourceFeedbackIds.map((id) => BigInt(id))
                )
            )
    }

    log.info(
        { module: 'learning', suggestionId: Number(suggestionId), documentId: Number(doc.id) },
        'Applied KB suggestion'
    )
}
