import { existsSync, readdirSync } from 'fs'
import path from 'path'

import Elysia, { t } from 'elysia'
import { eq, sql } from 'drizzle-orm'

import { db } from '../../db/client'
import { chunks, documents } from '../../db/schema'
import { embedBatch } from '../../services/llm/openrouter'
import { chunkText } from '../../services/rag/chunker'

const DATASET_DIR = path.resolve(import.meta.dir, '../../../dataset')

interface ParsedMd {
    title: string
    meta: Record<string, string>
    body: string
}

function parseMdFile(content: string): ParsedMd {
    const lines = content.split('\n')
    const title = lines[0]?.replace(/^#\s+/, '').trim() ?? ''

    const meta: Record<string, string> = {}
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        const m = line.match(/^\*\*(\w+):\*\*\s*(.*)/)
        if (m) {
            meta[m[1].toLowerCase()] = m[2].trim()
        }
    }

    const sepIndex = lines.findIndex((l) => l.trim() === '---')
    const body = sepIndex !== -1
        ? lines.slice(sepIndex + 1).join('\n').trim()
        : lines.slice(1).join('\n').trim()

    return { title, meta, body }
}

export const ingestController = new Elysia({
    name: 'module.admin.ingest',
    prefix: '/ingest',
    detail: { tags: ['Admin'] }
}).post(
    '/dataset',
    async ({ query }) => {
        if (!existsSync(DATASET_DIR)) {
            return { error: `Dataset directory not found: ${DATASET_DIR}` }
        }

        const files = readdirSync(DATASET_DIR).filter((f) => f.endsWith('.md'))
        const total = files.length
        const processed: { id: string; title: string; chunkCount: number }[] = []
        const errors: string[] = []
        let skipped = 0
        const insertedDocIds: bigint[] = []

        for (const filename of files) {
            try {
                const filePath = path.join(DATASET_DIR, filename)
                const content = await Bun.file(filePath).text()
                const { title, meta, body } = parseMdFile(content)

                if (!title || !body) {
                    errors.push(`${filename}: missing title or body`)
                    continue
                }

                const existing = await db
                    .select({ id: documents.id })
                    .from(documents)
                    .where(eq(documents.title, title))
                    .then((rows) => rows[0])

                if (existing) {
                    if (!query.force) {
                        skipped++
                        continue
                    }
                    await db.delete(documents).where(eq(documents.id, existing.id))
                }

                const [doc] = await db
                    .insert(documents)
                    .values({
                        title,
                        source: 'seed',
                        metadata: {
                            date: meta.date ?? null,
                            city: meta.city ?? null,
                            type: meta.type ?? null,
                            link: meta.link ?? null,
                            filename
                        } as Record<string, unknown>
                    })
                    .returning({ id: documents.id })

                insertedDocIds.push(doc.id)

                const textChunks = chunkText(body)

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

                processed.push({
                    id: doc.id.toString(),
                    title,
                    chunkCount: textChunks.length
                })
            } catch (err) {
                errors.push(`${filename}: ${String(err)}`)
            }
        }

        if (insertedDocIds.length > 0) {
            const idList = insertedDocIds.join(',')
            await db.execute(sql`
                UPDATE chunks
                SET tsv = to_tsvector('russian', text)
                WHERE document_id IN (${sql.raw(idList)})
                  AND tsv IS NULL
            `)
        }

        return {
            total,
            processed: processed.length,
            skipped,
            errors: errors.length > 0 ? errors : undefined,
            documents: processed
        }
    },
    {
        query: t.Object({
            force: t.Optional(t.Boolean({ default: false }))
        }),
        detail: {
            summary: 'Seed RAG from dataset',
            description: 'Read all .md files from ./dataset, chunk, embed, and store in RAG store'
        }
    }
)
