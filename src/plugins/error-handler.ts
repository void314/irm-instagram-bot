import Elysia from 'elysia'

export const globalErrorHandler = new Elysia({ name: 'plugin.error-handler' }).onError(
    ({ code, error, path, set }) => {
        console.error(`🦊 [Elysia] Error at ${path}:`, (error as Error).message)

        if (code === 'VALIDATION') {
            set.status = 400
            return {
                success: false,
                code,
                message: 'Validation Error',
                details: error.all
            }
        }

        if (code === 'NOT_FOUND') {
            set.status = 404
            return {
                success: false,
                code,
                message: 'Not Found',
                path
            }
        }

        set.status = 500
        return {
            success: false,
            code,
            message: (error as Error).message || 'Internal Server Error',
            path
        }
    }
)
