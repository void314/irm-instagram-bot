import { describe, expect, it } from 'bun:test'

import app from '../../src/app'

describe('Auth Facebook Module', () => {
    it('should return 400 when oauth callback code is missing', async () => {
        const response = await app.handle(new Request('http://localhost/api/auth/facebook/callback'))
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body).toEqual({
            error: 'Missing code parameter'
        })
    })
})
