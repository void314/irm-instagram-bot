import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { db } from '../src/db/client'

async function main() {
    try {
        console.log('Running migrations...')
        await migrate(db, { migrationsFolder: './src/db/migrations' })
        console.log('Migrations complete!')
        process.exit(0)
    } catch (err) {
        console.error('Migration failed:', err)
        process.exit(1)
    }
}
main()

