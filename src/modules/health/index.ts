import Elysia, { status } from 'elysia'

import { healthResponse200, healthResponse400 } from './model'
import { HealthService } from './service'

const healthService = new HealthService()

export const healthController = new Elysia({
    name: 'module.health',
    prefix: '/health',
    detail: { tags: ['Health'] }
}).get(
    '/',
    () => {
        const result = healthService.check()

        if (result.status === 'error') {
            return status(400, result)
        }

        return result
    },
    {
        response: {
            200: healthResponse200,
            400: healthResponse400
        },
        detail: {
            summary: 'Health Check API',
            description: 'Check the health of the application'
        }
    }
)
