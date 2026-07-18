import Elysia, { status } from 'elysia'

import * as models from './model'
import { HealthService } from './service'

const healthService = new HealthService()

export const healthController = new Elysia({
    name: 'module.health',
    prefix: '/health',
    detail: { tags: ['Health'] }
})
    .model(models)
    .get(
        '/',
        async () => {
            return await healthService.check()
        },
        {
            response: {
                200: 'healthResponse200',
                500: 'healthResponse500'
            },
            detail: {
                summary: 'Health Check API',
                description: 'Check the health of the application'
            }
        }
    )
