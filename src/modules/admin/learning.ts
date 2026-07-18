import Elysia, { status, t } from 'elysia'
import { count, desc, eq, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { kbSuggestions, learningDocs, learnChunks, responseFeedback, chunks } from '../../db/schema'
import { applySuggestionQueue, suggestionsQueue } from '../../agents/learning/scheduler'

import { isLearningEnabled, toggleLearning } from '../../config/learning'

export const learningController = new Elysia({
    name: 'module.admin.learning',
    prefix: '/learning',
    detail: { tags: ['Admin', 'Learning'] }
})

learningController.get(
    '/kb-suggestions',
    async ({ query: { limit, offset, status: statusFilter } }) => {
        const query = db
            .select()
            .from(kbSuggestions)
            .where(statusFilter ? eq(kbSuggestions.status, statusFilter) : sql`TRUE`)
            
        const rows = await query
            .orderBy(desc(kbSuggestions.createdAt))
            .limit(limit ?? 50)
            .offset(offset ?? 0)

        const totalQuery = db
            .select({ count: count() })
            .from(kbSuggestions)
            .where(statusFilter ? eq(kbSuggestions.status, statusFilter) : sql`TRUE`)

        const total = await totalQuery.then((r) => Number(r[0].count))

        return { suggestions: rows, total }
    },
    {
        query: t.Object({
            limit: t.Optional(t.Numeric({ default: 50, maximum: 200 })),
            offset: t.Optional(t.Numeric({ default: 0 })),
            status: t.Optional(t.String())
        }),
        detail: {
            summary: 'List KB suggestions',
            description: 'Returns list of AI generated knowledge base suggestions'
        }
    }
)

learningController.post(
    '/kb-suggestions/:id/approve',
    async ({ params: { id } }) => {
        const suggestionId = BigInt(id)
        
        let suggestion = await db.select().from(kbSuggestions).where(eq(kbSuggestions.id, suggestionId)).then(r => r[0])
        if (!suggestion) return status(404, { error: 'Suggestion not found' })
        
        await db.update(kbSuggestions)
            .set({ status: 'approved' })
            .where(eq(kbSuggestions.id, suggestionId))
            
        // Queue job to apply
        await applySuggestionQueue.add('apply', { suggestionId: id })
            
        return { success: true, queued: true }
    },
    {
        params: t.Object({ id: t.String() }),
        detail: {
            summary: 'Approve suggestion',
            description: 'Approves suggestion and queues it for embedding and saving into learning store'
        }
    }
)

learningController.post(
    '/kb-suggestions/:id/reject',
    async ({ params: { id } }) => {
        const suggestionId = BigInt(id)
        
        let suggestion = await db.select().from(kbSuggestions).where(eq(kbSuggestions.id, suggestionId)).then(r => r[0])
        if (!suggestion) return status(404, { error: 'Suggestion not found' })
        
        await db.update(kbSuggestions)
            .set({ status: 'rejected' })
            .where(eq(kbSuggestions.id, suggestionId))
            
        // Mark source feedbacks as rejected? Let's just mark them pending or rejected based on logic. Let's leave them or mark rejected.
        if (suggestion.sourceFeedbackIds && suggestion.sourceFeedbackIds.length > 0) {
            await db.update(responseFeedback)
                .set({ status: 'rejected' })
                .where(sql`${responseFeedback.id} = ANY(${suggestion.sourceFeedbackIds})`)
        }
            
        return { success: true }
    },
    {
        params: t.Object({ id: t.String() }),
        detail: {
            summary: 'Reject suggestion',
            description: 'Rejects suggestion'
        }
    }
)

learningController.post(
    '/generate-suggestions',
    async () => {
        await suggestionsQueue.add('manual-generation', {})
        return { success: true, queued: true }
    },
    {
        detail: {
            summary: 'Force generate suggestions',
            description: 'Manually trigger background job to generate suggestions from pending feedback'
        }
    }
)

learningController.post(
    '/rollback',
    async () => {
        // Delete all from learn_chunks, then learning_docs
        await db.delete(learnChunks)
        await db.delete(learningDocs)
        
        // Mark all feedback and kb_suggestions back to pending or something?
        // Let's just delete the learned docs for now.
        return { success: true }
    },
    {
        detail: {
            summary: 'Rollback Learning Store',
            description: 'Deletes all learning chunks and docs. Leaves RAG store intact.'
        }
    }
)

learningController.post(
    '/toggle',
    async ({ body }) => {
        toggleLearning(body.enabled)
        return { success: true, enabled: isLearningEnabled }
    },
    {
        body: t.Object({ enabled: t.Boolean() }),
        detail: {
            summary: 'Toggle Learning Store',
            description: 'Enables or disables learning store search across the system'
        }
    }
)

learningController.get(
    '/stats',
    async () => {
        const totalCorrections = await db.select({ count: count() }).from(responseFeedback).then(r => Number(r[0].count))
        const pendingFeedback = await db.select({ count: count() }).from(responseFeedback).where(eq(responseFeedback.status, 'pending')).then(r => Number(r[0].count))
        const pendingSuggestions = await db.select({ count: count() }).from(kbSuggestions).where(eq(kbSuggestions.status, 'pending')).then(r => Number(r[0].count))
        const appliedDocuments = await db.select({ count: count() }).from(learningDocs).then(r => Number(r[0].count))
        const ragChunksCount = await db.select({ count: count() }).from(chunks).then(r => Number(r[0].count))
        const learnChunksCount = await db.select({ count: count() }).from(learnChunks).then(r => Number(r[0].count))
        
        // Simple heatmap of top 5 sessionIds (topics)
        const topics = await db.execute<{ session_id: string, count: number }>(sql`
            SELECT session_id, COUNT(*) as count 
            FROM response_feedback 
            WHERE session_id IS NOT NULL
            GROUP BY session_id 
            ORDER BY count DESC 
            LIMIT 5
        `)
        
        return {
            totalCorrections,
            pendingFeedback,
            pendingSuggestions,
            appliedDocuments,
            ragChunksCount,
            learnChunksCount,
            learningEnabled: isLearningEnabled,
            topicsHeatmap: topics.map(t => ({ topic: t.session_id, count: Number(t.count) }))
        }
    },
    {
        detail: {
            summary: 'Learning Stats',
            description: 'Returns statistics for the learning dashboard'
        }
    }
)
