import Elysia, { status } from 'elysia'

import { healthResponse200, healthResponse500 } from './model'
import { HealthService } from './service'

const healthService = new HealthService()

export const healthController = new Elysia({
    name: 'module.health',
    prefix: '/health',
    detail: { tags: ['Health'] }
}).get(
    '/',
    async () => {
        const result = await healthService.check()

        if (result.status === 'error') {
            return status(500, result)
        }

        return result
    },
    {
        response: {
            200: healthResponse200,
            500: healthResponse500
        },
        detail: {
            summary: 'Health Check API',
            description: 'Check the health of the application'
        }
    }
)
