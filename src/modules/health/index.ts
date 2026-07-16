import Elysia from 'elysia'

import { healthResponse200, healthResponse400 } from './model'
import { HealthService } from './service'

const healthService = new HealthService()

export const healthController = new Elysia({ prefix: '/health', detail: { tags: ['Health'] } }).get(
    '/',
    ({ set }) => {
        const result = healthService.check()

        if (result.status === 'error') {
            set.status = 400
            return result
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
