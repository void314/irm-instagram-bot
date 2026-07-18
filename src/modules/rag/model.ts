import * as v from 'valibot'

export const askBody = v.object({
    question: v.string(),
    conversationId: v.optional(v.string()),
    verbose: v.optional(v.boolean())
})

export const askResponse200 = v.object({
    answer: v.string(),
    contextChunks: v.array(
        v.object({
            text: v.string(),
            score: v.number()
        })
    ),
    intent: v.string(),
    needsClarification: v.boolean(),
    debug: v.optional(
        v.object({
            intentType: v.string(),
            historyLength: v.number(),
            searchResultsCount: v.number(),
            topScore: v.number(),
            topChunkSnippet: v.string(),
            allScores: v.array(v.number()),
            groundingPassed: v.boolean()
        })
    )
})

export const documentCreateBody = v.object({
    title: v.string(),
    text: v.string(),
    metadata: v.optional(v.record(v.string(), v.unknown()))
})

export const documentCreateResponse200 = v.object({
    id: v.string(),
    title: v.string(),
    chunkCount: v.number()
})

export const documentsListResponse200 = v.array(
    v.object({
        id: v.string(),
        title: v.string(),
        source: v.string(),
        chunkCount: v.number(),
        createdAt: v.string()
    })
)

export const documentDetailResponse200 = v.object({
    id: v.string(),
    title: v.string(),
    source: v.string(),
    metadata: v.optional(v.record(v.string(), v.unknown())),
    chunkCount: v.number(),
    text: v.string(),
    createdAt: v.string()
})

export const documentUpdateBody = v.object({
    title: v.optional(v.string()),
    text: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.unknown()))
})

export const documentDeleteResponse200 = v.object({
    success: v.literal(true),
    id: v.string()
})

export const reembedResponse200 = v.object({
    success: v.literal(true),
    reembedded: v.number()
})

export const errorResponse400 = v.object({
    error: v.string(),
    details: v.optional(v.unknown())
})

export type AskBody = v.InferOutput<typeof askBody>
export type DocumentCreateBody = v.InferOutput<typeof documentCreateBody>
export type DocumentUpdateBody = v.InferOutput<typeof documentUpdateBody>
export type DocumentDetailResponse200 = v.InferOutput<typeof documentDetailResponse200>
export type ErrorResponse400 = v.InferOutput<typeof errorResponse400>
