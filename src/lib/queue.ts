import { Queue, Worker, type Job, type Processor } from 'bullmq'
import Redis from 'ioredis'
import { env } from '../config/constants'

// Redis connection shared among queues and workers
export const redisConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null // Required by bullmq
})

interface QueueConfig {
    name: string
    processor?: Processor
}

// Registry for queues to allow graceful shutdown
export const queues: Record<string, Queue> = {}
export const workers: Record<string, Worker> = {}

export function createQueue(name: string): Queue {
    if (!queues[name]) {
        queues[name] = new Queue(name, { connection: redisConnection })
    }
    return queues[name]
}

export function createWorker(name: string, processor: Processor): Worker {
    if (!workers[name]) {
        workers[name] = new Worker(name, processor, { connection: redisConnection })
    }
    return workers[name]
}

export async function shutdownQueues() {
    console.log('Shutting down BullMQ queues and workers...')
    const workerPromises = Object.values(workers).map((w) => w.close())
    const queuePromises = Object.values(queues).map((q) => q.close())
    await Promise.all([...workerPromises, ...queuePromises])
    await redisConnection.quit()
    console.log('BullMQ shutdown complete.')
}
