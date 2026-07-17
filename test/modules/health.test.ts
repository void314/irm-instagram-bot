import { describe, expect, it } from 'bun:test'

import app from '../../src/app'

describe('Health Module', () => {
    it('should return 200 and online status', async () => {
        // ! Мы тестируем именно app (который экспортируется из app.ts без запуска сервера)
        // ! Это лучшая практика Elysia — вызов .handle(new Request())
        const response = await app.handle(new Request('http://localhost/api/health'))
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toEqual({ status: 'online', message: 'Database is healthy', data: { ok: 1 } })
    })

    // Пример теста на 404
    it('should return 404 for unknown route', async () => {
        const response = await app.handle(new Request('http://localhost/api/unknown'))
        expect(response.status).toBe(404)
    })
})
