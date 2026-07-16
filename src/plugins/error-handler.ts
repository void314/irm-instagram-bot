import Elysia from 'elysia'

export const globalErrorHandler = new Elysia({ name: 'plugin.error-handler' }).onError(({ code, error, path }) => {
    console.error(`🦊 [Elysia] Error at ${path}:`, (error as Error).message)

    return {
        success: false,
        code,
        message: (error as Error).message || 'Internal Server Error',
        path
    }
})
