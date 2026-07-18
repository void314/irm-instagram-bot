import Elysia from 'elysia'

import * as models from './model'
import { HealthService } from './service'

export const healthController = new Elysia({
    name: 'module.health',
    prefix: '/health',
    detail: { tags: ['Health'] }
})
    .decorate('healthService', new HealthService())
    .model(models)
    .get(
        '/',
        async ({ healthService }) => {
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
