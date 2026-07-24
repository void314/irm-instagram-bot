import { afterEach, describe, expect, it } from 'bun:test'

import { detectIntentLLM } from '../../src/services/rag/intent'

const originalFetch = globalThis.fetch

function createMockFetch(json: unknown): typeof fetch {
    const mock = (async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify(json), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        })) as typeof fetch

    return Object.assign(mock, originalFetch)
}

function createChatResult(content: string): Record<string, unknown> {
    return {
        id: 'chatcmpl_test',
        object: 'chat.completion',
        created: 1_784_877_580,
        model: 'openrouter/test-model',
        system_fingerprint: null,
        choices: [
            {
                index: 0,
                finish_reason: 'stop',
                message: {
                    role: 'assistant',
                    content
                }
            }
        ]
    }
}

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('detectIntentLLM', () => {
    it('returns all valid intents from the model response', async () => {
        globalThis.fetch = createMockFetch(createChatResult('{"intents":["booking","prices","booking","unknown"]}'))

        const result = await detectIntentLLM('Хочу записаться и узнать цену')

        expect(Array.isArray(result.intents)).toBe(true)
        expect(result.intents.length).toBeGreaterThan(1)
    })

    it('keeps backward compatibility with singular intent responses', async () => {
        globalThis.fetch = createMockFetch(createChatResult('{"intent":"query"}'))

        const result = await detectIntentLLM('Где находится клиника?')

        expect(result).toEqual({ intents: ['query'] })
    })
})

