import { OpenRouter } from '@openrouter/sdk'
import type { ChatContentImage, ChatContentText, ChatFunctionTool, ChatMessages, ChatRequest, ChatResult, ChatToolCall } from '@openrouter/sdk/models'
import type { CreateEmbeddingsResponseBody } from '@openrouter/sdk/models/operations/createembeddings'

import { env } from '../../config/constants'
import { log } from '../logger'

const openrouter = new OpenRouter({
    apiKey: env.OPENROUTER_API_KEY
})

export type ToolDefinition = ChatFunctionTool
export type ToolCall = ChatToolCall
export type ChatMessage = ChatMessages
export type ChatOptions = Pick<ChatRequest, 'model' | 'temperature' | 'maxTokens' | 'tools' | 'toolChoice' | 'responseFormat'>

export type MultimodalContent = ChatContentText | ChatContentImage

function isChatResult(value: unknown): value is ChatResult {
    return typeof value === 'object' && value !== null && 'choices' in value
}

function isEmbeddingsResponseBody(value: unknown): value is CreateEmbeddingsResponseBody {
    return typeof value === 'object' && value !== null && 'data' in value
}

export async function chat(messages: ChatMessage[], opts?: ChatOptions): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    const model = opts?.model || env.LLM_MODEL
    const t0 = performance.now()

    log.debug(
        {
            module: 'llm:chat',
            model,
            messages: messages.map((message) => ({
                role: message.role,
                contentLength: typeof message.content === 'string' ? message.content.length : (message.content?.length ?? 0),
                toolCalls: message.role === 'assistant' ? (message.toolCalls?.length ?? 0) : 0
            })),
            toolsCount: opts?.tools?.length ?? 0
        },
        'LLM request'
    )

    try {
        const response = await openrouter.chat.send({
            chatRequest: {
                ...opts,
                model,
                messages,
                temperature: opts?.temperature ?? 0.7,
                maxTokens: opts?.maxTokens ?? 1024,
                stream: false
            }
        })

        if (!isChatResult(response)) {
            throw new Error('Streaming response is not supported in llm/openrouter.ts wrapper')
        }

        const duration = (performance.now() - t0).toFixed(0)
        const msg = response.choices[0]?.message

        log.debug(
            {
                module: 'llm:chat',
                model,
                duration: `${duration}ms`,
                contentLength: typeof msg?.content === 'string' ? msg.content.length : 0,
                toolCallsCount: msg?.toolCalls?.length ?? 0
            },
            'LLM response'
        )

        return {
            content: typeof msg?.content === 'string' ? msg.content : '',
            toolCalls: msg?.toolCalls
        }
    } catch (err) {
        const duration = (performance.now() - t0).toFixed(0)
        log.error({ module: 'llm:chat', model, duration: `${duration}ms`, error: String(err) }, 'LLM error')
        throw err
    }
}

export async function generateEmbedding(text: string): Promise<number[]> {
    const model = env.EMBED_MODEL
    const t0 = performance.now()

    log.debug({ module: 'llm:embed', model, inputLength: text.length }, 'Embedding request')

    try {
        const response = await openrouter.embeddings.generate({
            requestBody: {
                model,
                input: text
            }
        })

        if (!isEmbeddingsResponseBody(response)) {
            throw new Error('Unexpected embeddings response format')
        }

        const duration = (performance.now() - t0).toFixed(0)
        const embedding = response.data[0]?.embedding

        if (!Array.isArray(embedding)) {
            throw new Error('Expected numeric embedding array from OpenRouter')
        }

        log.debug({ module: 'llm:embed', model, duration: `${duration}ms`, dimensions: embedding.length }, 'Embedding response')

        return embedding
    } catch (err) {
        const duration = (performance.now() - t0).toFixed(0)
        log.error({ module: 'llm:embed', model, duration: `${duration}ms`, error: String(err) }, 'Embedding error')
        throw err
    }
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(generateEmbedding))
}
