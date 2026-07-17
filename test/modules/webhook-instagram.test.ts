import { describe, expect, it } from 'bun:test'

import app from '../../src/app'

describe('Instagram Webhook Module', () => {
    it('should return 403 for invalid verification request', async () => {
        const response = await app.handle(
            new Request(
                'http://localhost/api/webhook/instagram?hub.mode=subscribe&hub.verify_token=invalid&hub.challenge=test'
            )
        )
        const body = await response.json()

        expect(response.status).toBe(403)
        expect(body.status).toBe('error')
    })

    it('should accept valid webhook payload shape', async () => {
        const response = await app.handle(
            new Request('http://localhost/api/webhook/instagram', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    object: 'page',
                    entry: []
                })
            })
        )
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toEqual({ status: 'ok' })
    })
})
