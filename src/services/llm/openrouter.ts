import { env } from '../../config/constants'
import { log } from '../logger'

export interface ToolDefinition {
    type: 'function'
    function: {
        name: string
        description: string
        parameters: Record<string, unknown>
    }
}

export interface ChatOptions {
    model?: string
    temperature?: number
    max_tokens?: number
    tools?: ToolDefinition[]
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
    response_format?: { type: 'json_object' }
}

export interface ToolCall {
    id: string
    type: 'function'
    function: {
        name: string
        arguments: string
    }
}

interface ChatResponse {
    choices: {
        message: {
            content: string | null
            tool_calls?: ToolCall[]
        }
    }[]
}

function getHeaders(): Record<string, string> {
    const key = env.OPENROUTER_API_KEY
    if (!key) {
        throw new Error('OPENROUTER_API_KEY is not set')
    }
    return {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
    }
}

export type MultimodalContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

export type ChatMessage =
    | { role: 'system' | 'user'; content: string | MultimodalContent[] }
    | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
    | { role: 'tool'; content: string; tool_call_id: string }

export async function chat(messages: ChatMessage[], opts?: ChatOptions): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    const model = opts?.model || env.LLM_MODEL
    const body: Record<string, unknown> = {
        model,
        messages,
        temperature: opts?.temperature ?? 0.7,
        max_tokens: opts?.max_tokens ?? 1024
    }

    if (opts?.tools) body.tools = opts.tools
    if (opts?.tool_choice) body.tool_choice = opts.tool_choice
    if (opts?.response_format) body.response_format = opts.response_format

    const t0 = performance.now()

    log.debug(
        {
            module: 'llm:chat',
            model,
            messages: messages.map((m) => ({
                role: m.role,
                contentLength: m.content?.length ?? 0,
                toolCalls: (m as any).tool_calls?.length ?? 0
            })),
            toolsCount: opts?.tools?.length ?? 0
        },
        'LLM request'
    )

    const res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body)
    })

    const duration = (performance.now() - t0).toFixed(0)

    if (!res.ok) {
        const text = await res.text()
        log.error({ module: 'llm:chat', model, status: res.status, duration: `${duration}ms` }, `LLM error: ${text.slice(0, 200)}`)
        throw new Error(`OpenRouter chat error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as ChatResponse
    const msg = data.choices[0].message

    log.debug(
        {
            module: 'llm:chat',
            model,
            duration: `${duration}ms`,
            contentLength: msg.content?.length ?? 0,
            toolCallsCount: msg.tool_calls?.length ?? 0
        },
        'LLM response'
    )

    return {
        content: msg.content ?? '',
        toolCalls: msg.tool_calls
    }
}

export async function generateEmbedding(text: string): Promise<number[]> {
    log.debug({ module: 'llm:embed', model: env.EMBED_MODEL, inputLength: text.length }, 'Embedding request')

    const t0 = performance.now()

    const res = await fetch(`${env.OPENROUTER_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            model: env.EMBED_MODEL,
            input: text
        })
    })

    const duration = (performance.now() - t0).toFixed(0)

    if (!res.ok) {
        const errText = await res.text()
        log.error(
            { module: 'llm:embed', model: env.EMBED_MODEL, status: res.status, duration: `${duration}ms` },
            `Embedding error: ${errText.slice(0, 200)}`
        )
        throw new Error(`OpenRouter embedding error ${res.status}: ${errText}`)
    }

    const data = (await res.json()) as Record<string, unknown>
    const rawData = data.data as Record<string, unknown>[]

    if (!rawData?.[0]) {
        throw new Error(`Unexpected embedding response: ${JSON.stringify(data).slice(0, 500)}`)
    }

    const embedding = (rawData[0].embedding ?? rawData[0].values) as number[] | undefined
    if (!embedding) {
        throw new Error(`No embedding in response: ${JSON.stringify(rawData[0]).slice(0, 500)}`)
    }

    log.debug({ module: 'llm:embed', model: env.EMBED_MODEL, duration: `${duration}ms`, dimensions: embedding.length }, 'Embedding response')

    return embedding
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(generateEmbedding))
}
