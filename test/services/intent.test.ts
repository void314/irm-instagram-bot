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

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('detectIntentLLM', () => {
    it('returns all valid intents from the model response', async () => {
        globalThis.fetch = createMockFetch({
            choices: [
                {
                    message: {
                        content: '{"intents":["booking","prices","booking","unknown"]}'
                    }
                }
            ]
        })

        const result = await detectIntentLLM('Хочу записаться и узнать цену')

        expect(result).toEqual({ intents: ['booking', 'prices'] })
    })

    it('keeps backward compatibility with singular intent responses', async () => {
        globalThis.fetch = createMockFetch({
            choices: [
                {
                    message: {
                        content: '{"intent":"query"}'
                    }
                }
            ]
        })

        const result = await detectIntentLLM('Где находится клиника?')

        expect(result).toEqual({ intents: ['query'] })
    })
})

