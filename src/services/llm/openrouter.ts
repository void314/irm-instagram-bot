import { env } from '../../config/constants'

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

export async function chat(messages: { role: string; content: string }[]): Promise<string> {
    const res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            model: env.LLM_MODEL,
            messages,
            temperature: 0.7,
            max_tokens: 1024
        })
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`OpenRouter chat error ${res.status}: ${text}`)
    }

    const data = (await res.json()) as {
        choices: { message: { content: string | null } }[]
    }

    return data.choices[0].message.content ?? ''
}

export async function generateEmbedding(text: string): Promise<number[]> {
    const res = await fetch(`${env.OPENROUTER_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            model: env.EMBED_MODEL,
            input: text
        })
    })

    if (!res.ok) {
        const errText = await res.text()
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

    return embedding
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(generateEmbedding))
}
