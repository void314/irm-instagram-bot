import Elysia, { status, t } from 'elysia'

import { desc, eq, ilike, or, sql } from 'drizzle-orm'

import * as models from './model'
import { type RagContext, runPipeline } from '../../agents/orchestrator'
import { db } from '../../db/client'
import { chunks, conversations, documents } from '../../db/schema'
import { embedBatch } from '../../services/llm/openrouter'
import { chunkText } from '../../services/rag/chunker'

export const ragController = new Elysia({
    name: 'module.rag',
    prefix: '/rag',
    detail: { tags: ['RAG'] }
})
    .model(models)
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
                return status(500, { error: String(err) } as models.ErrorResponse400)
            }
        },
        {
            body: 'askBody',
            response: {
                200: 'askResponse200',
                500: 'errorResponse400'
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
                return status(400, { error: String(err) } as models.ErrorResponse400)
            }
        },
        {
            body: 'documentCreateBody',
            response: {
                200: 'documentCreateResponse200',
                400: 'errorResponse400'
            },
            detail: {
                summary: 'Create a document',
                description: 'Ingest a document: chunk, embed, and store'
            }
        }
    )
    .get(
        '/documents',
        async ({ query: { q } }) => {
            const searchQuery = q?.trim()
            const searchPattern = searchQuery ? `%${searchQuery}%` : undefined
            const filterCondition = searchPattern
                ? or(
                      ilike(documents.title, searchPattern),
                      sql<boolean>`
                          EXISTS (
                              SELECT 1
                              FROM ${chunks} search_chunks
                              WHERE search_chunks.document_id = ${documents.id}
                                AND search_chunks.text ILIKE ${searchPattern}
                          )
                      `
                  )
                : sql`TRUE`

            const rows = await db
                .select({
                    id: documents.id,
                    title: documents.title,
                    source: documents.source,
                    chunkCount: sql<number>`
                        (
                            SELECT COUNT(*)
                            FROM ${chunks} counted_chunks
                            WHERE counted_chunks.document_id = ${documents.id}
                        )
                    `,
                    createdAt: documents.createdAt
                })
                .from(documents)
                .where(filterCondition)
                .orderBy(desc(documents.createdAt))

            return rows.map((r) => ({
                id: r.id.toString(),
                title: r.title,
                source: r.source,
                chunkCount: Number(r.chunkCount),
                createdAt: r.createdAt.toISOString()
            }))
        },
        {
            query: t.Object({
                q: t.Optional(t.String())
            }),
            response: {
                200: 'documentsListResponse200'
            },
            detail: {
                summary: 'List documents',
                description: 'Returns documents with chunk counts and optional search by title or content'
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
                return status(404, { error: 'Document not found' } as models.ErrorResponse400)
            }

            const chunksRows = await db.select({ text: chunks.text }).from(chunks).where(eq(chunks.documentId, docId)).orderBy(chunks.index)

            const text = chunksRows.map((c) => c.text).join('\n\n')

            return {
                id: doc.id.toString(),
                title: doc.title,
                source: doc.source,
                metadata: (doc.metadata ?? undefined) as Record<string, unknown> | undefined,
                chunkCount: chunksRows.length,
                text,
                createdAt: doc.createdAt?.toISOString() ?? ''
            } as models.DocumentDetailResponse200
        },
        {
            response: {
                200: 'documentDetailResponse200',
                404: 'errorResponse400'
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
                return status(404, { error: 'Document not found' } as models.ErrorResponse400)
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
            body: 'documentUpdateBody',
            response: {
                200: 'documentCreateResponse200',
                404: 'errorResponse400'
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
                return status(404, { error: 'Document not found' } as models.ErrorResponse400)
            }

            await db.delete(documents).where(eq(documents.id, docId))

            return { success: true as const, id: docId.toString() }
        },
        {
            response: {
                200: 'documentDeleteResponse200',
                404: 'errorResponse400'
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
            const allChunks = await db.select({ id: chunks.id, text: chunks.text }).from(chunks)

            let reembedded = 0

            for (const chunk of allChunks) {
                const embedding = (await embedBatch([chunk.text]))[0]
                await db.update(chunks).set({ embedding }).where(eq(chunks.id, chunk.id))
                reembedded++
            }

            return { success: true as const, reembedded }
        },
        {
            response: {
                200: 'reembedResponse200'
            },
            detail: {
                summary: 'Re-embed all chunks',
                description: 'Regenerate embeddings for all chunks using current embed model'
            }
        }
    )
