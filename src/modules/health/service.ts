import type { HealthResponse200, HealthResponse400 } from './model'

export class HealthService {
    public check(): HealthResponse200 | HealthResponse400 {
        const isHealthy = true // TODO: Добавить реальную проверку БД/Кэша

        if (!isHealthy) {
            return {
                status: 'error',
                message: 'Service is not healthy'
            }
        }

        return {
            status: 'online'
        }
    }
}
