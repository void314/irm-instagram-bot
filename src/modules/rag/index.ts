import Elysia, { status } from 'elysia'

import { db } from '../../db/client'
import { documents, chunks, conversations } from '../../db/schema'
import { chunkText } from '../../services/rag/chunker'
import { runPipeline, type RagContext } from '../../services/rag/orchestrator'
import { embedBatch } from '../../services/llm/openrouter'
import { eq, sql } from 'drizzle-orm'
import {
    askBody,
    askResponse200,
    documentCreateBody,
    documentCreateResponse200,
    documentDeleteResponse200,
    documentDetailResponse200,
    documentsListResponse200,
    documentUpdateBody,
    errorResponse400,
    reembedResponse200
} from './model'
import { env } from '../../config/constants'

export const ragController = new Elysia({
    name: 'module.rag',
    prefix: '/rag',
    detail: { tags: ['RAG'] }
})
    .post(
        '/ask',
        async ({ body }) => {
            try {
                let ctx: RagContext | undefined
                if (body.conversationId) {
                    const conversationId = BigInt(body.conversationId)
                    // RagContext требует senderId (нужен для карточки пациента), поэтому
                    // подтягиваем его из уже существующей записи разговора, а не полагаемся
                    // на то, что вызывающая сторона его передаст.
                    const conv = await db
                        .select({ senderId: conversations.senderId })
                        .from(conversations)
                        .where(eq(conversations.id, conversationId))
                        .then((rows) => rows[0])

                    if (conv) {
                        ctx = { conversationId, senderId: conv.senderId }
                    }
                }
                const result = await runPipeline(body.question, ctx, body.verbose ?? false)
                return result
            } catch (err) {
                return status(500, { error: String(err) })
            }
        },
        {
            body: askBody,
            response: {
                200: askResponse200,
                500: errorResponse400
            },
            detail: {
                summary: 'Ask a question with RAG',
                description: 'Performs vector search + LLM and returns answer with context'
            }
        }
    )
    .post(
        '/documents',
        async ({ body }) => {
            try {
                const [doc] = await db
                    .insert(documents)
                    .values({
                        title: body.title,
                        source: 'manual',
                        metadata: (body.metadata ?? {}) as Record<string, unknown>
                    })
                    .returning({ id: documents.id })

                const textChunks = chunkText(body.text)

                if (textChunks.length > 0) {
                    const embeddings = await embedBatch(textChunks.map((c) => c.content))

                    await db.insert(chunks).values(
                        textChunks.map((c, i) => ({
                            documentId: doc.id,
                            index: c.index,
                            text: c.content,
                            embedding: embeddings[i],
                            metadata: null
                        }))
                    )
                }

                return {
                    id: doc.id.toString(),
                    title: body.title,
                    chunkCount: textChunks.length
                }
            } catch (err) {
                return status(400, { error: String(err) })
            }
        },
        {
            body: documentCreateBody,
            response: {
                200: documentCreateResponse200,
                400: errorResponse400
            },
            detail: {
                summary: 'Create a document',
                description: 'Ingest a document: chunk, embed, and store'
            }
        }
    )
    .get(
        '/documents',
        async () => {
            const rows = await db.execute<{
                id: string
                title: string
                source: string
                chunk_count: string
                created_at: string
            }>(
                sql`
                    SELECT
                        d.id,
                        d.title,
                        d.source,
                        (SELECT COUNT(*) FROM ${chunks} c WHERE c.document_id = d.id) AS chunk_count,
                        d.created_at
                    FROM ${documents} d
                    ORDER BY d.created_at DESC
                `
            )

            return rows.map((r) => ({
                id: r.id,
                title: r.title,
                source: r.source,
                chunkCount: Number.parseInt(r.chunk_count),
                createdAt: r.created_at
            }))
        },
        {
            response: {
                200: documentsListResponse200
            },
            detail: {
                summary: 'List documents',
                description: 'Returns all documents with chunk counts'
            }
        }
    )
    .get(
        '/documents/:id',
        async ({ params: { id } }) => {
            const docId = BigInt(id)

            const doc = await db
                .select()
                .from(documents)
                .where(eq(documents.id, docId))
                .then((rows) => rows[0])

            if (!doc) {
                return status(404, { error: 'Document not found' })
            }

            const chunksRows = await db
                .select({ text: chunks.text })
                .from(chunks)
                .where(eq(chunks.documentId, docId))
                .orderBy(chunks.index)

            const text = chunksRows.map((c) => c.text).join('\n\n')

            return {
                id: doc.id.toString(),
                title: doc.title,
                source: doc.source,
                metadata: doc.metadata,
                chunkCount: chunksRows.length,
                text,
                createdAt: doc.createdAt?.toISOString() ?? ''
            }
        },
        {
            response: {
                200: documentDetailResponse200,
                404: errorResponse400
            },
            detail: {
                summary: 'Get document details',
                description: 'Returns document metadata and chunk count'
            }
        }
    )
    .put(
        '/documents/:id',
        async ({ params: { id }, body }) => {
            const docId = BigInt(id)

            const existing = await db
                .select()
                .from(documents)
                .where(eq(documents.id, docId))
                .then((rows) => rows[0])

            if (!existing) {
                return status(404, { error: 'Document not found' })
            }

            const updateData: Partial<{ title: string; metadata: Record<string, unknown> }> = {}
            if (body.title !== undefined) updateData.title = body.title
            if (body.metadata !== undefined) updateData.metadata = body.metadata as Record<string, unknown>

            if (Object.keys(updateData).length > 0) {
                await db.update(documents).set(updateData).where(eq(documents.id, docId))
            }

            if (body.text !== undefined) {
                await db.delete(chunks).where(eq(chunks.documentId, docId))

                const textChunks = chunkText(body.text)

                if (textChunks.length > 0) {
                    const embeddings = await embedBatch(textChunks.map((c) => c.content))

                    await db.insert(chunks).values(
                        textChunks.map((c, i) => ({
                            documentId: docId,
                            index: c.index,
                            text: c.content,
                            embedding: embeddings[i],
                            metadata: null
                        }))
                    )
                }

                return {
                    id: docId.toString(),
                    title: body.title ?? existing.title,
                    chunkCount: textChunks.length
                }
            }

            const chunkCount = await db
                .select({ count: sql<number>`COUNT(*)` })
                .from(chunks)
                .where(eq(chunks.documentId, docId))
                .then((r) => Number(r[0].count))

            return {
                id: docId.toString(),
                title: body.title ?? existing.title,
                chunkCount
            }
        },
        {
            body: documentUpdateBody,
            response: {
                200: documentCreateResponse200,
                404: errorResponse400
            },
            detail: {
                summary: 'Update a document',
                description: 'Update title/metadata and optionally re-chunk + re-embed text'
            }
        }
    )
    .delete(
        '/documents/:id',
        async ({ params: { id } }) => {
            const docId = BigInt(id)

            const existing = await db
                .select()
                .from(documents)
                .where(eq(documents.id, docId))
                .then((rows) => rows[0])

            if (!existing) {
                return status(404, { error: 'Document not found' })
            }

            await db.delete(documents).where(eq(documents.id, docId))

            return { success: true as const, id: docId.toString() }
        },
        {
            response: {
                200: documentDeleteResponse200,
                404: errorResponse400
            },
            detail: {
                summary: 'Delete a document',
                description: 'Deletes document and its chunks (cascade)'
            }
        }
    )
    .post(
        '/documents/reembed',
        async () => {
            const allChunks = await db
                .select({ id: chunks.id, text: chunks.text })
                .from(chunks)

            let reembedded = 0

            for (const chunk of allChunks) {
                const embedding = (await embedBatch([chunk.text]))[0]
                await db
                    .update(chunks)
                    .set({ embedding })
                    .where(eq(chunks.id, chunk.id))
                reembedded++
            }

            return { success: true as const, reembedded }
        },
        {
            response: {
                200: reembedResponse200
            },
            detail: {
                summary: 'Re-embed all chunks',
                description: 'Regenerate embeddings for all chunks using current embed model'
            }
        }
    )
