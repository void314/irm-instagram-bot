import {
    bigint,
    boolean,
    customType,
    index,
    integer,
    jsonb,
    numeric,
    pgTable,
    text,
    timestamp,
    vector
} from 'drizzle-orm/pg-core'

const tsvector = customType<{ data: string | null }>({
    dataType() {
        return 'tsvector'
    }
})

export const conversations = pgTable('conversations', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    senderId: text('sender_id').notNull(),
    businessId: text('business_id').notNull(),
    summary: text('summary'),
    messageCount: integer('message_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>()
})

export const messages = pgTable('messages', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    conversationId: bigint('conversation_id', { mode: 'bigint' })
        .notNull()
        .references(() => conversations.id, { onDelete: 'cascade' }),
    mid: text('mid'),
    fromId: text('from_id').notNull(),
    text: text('text'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>()
})

export const documents = pgTable('documents', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    title: text('title').notNull(),
    source: text('source').notNull().default('manual'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull()
})

export const chunks = pgTable('chunks', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    documentId: bigint('document_id', { mode: 'bigint' })
        .notNull()
        .references(() => documents.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 3072 }),
    tsv: tsvector('tsv'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull()
})

export const patients = pgTable('patients', {
    senderId: text('sender_id').primaryKey(),
    name: text('name'),
    instagramName: text('instagram_name'),
    instagramUsername: text('instagram_username'),
    instagramProfilePic: text('instagram_profile_pic'),
    citizenship: text('citizenship'),
    phone: text('phone'),
    preferredLang: text('preferred_lang'),
    preferredBranch: text('preferred_branch'),
    preferredBranchRef1cId: text('preferred_branch_ref_1c_id'),
    hasBookedConsultation: boolean('has_booked_consultation').default(false).notNull(),
    nameSource: text('name_source'),
    nameChangeOffered: boolean('name_change_offered').default(false).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull()
})

export const services = pgTable('services', {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    ref1cId: text('ref_1c_id').notNull(),
    name: text('name').notNull(),
    price: numeric('price', { precision: 10, scale: 2 }),
    durationMinutes: integer('duration_minutes'),
    parentRef1cId: text('parent_ref_1c_id'),
    branchRef1cId: text('branch_ref_1c_id'),
    priceListId: text('price_list_id'),
    citizenship: text('citizenship').$type<'kz' | 'foreign'>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull()
})

export const accounts = pgTable('accounts', {
    igId: text('ig_id').primaryKey(),
    username: text('username'),
    tokenEncrypted: text('token_encrypted'),
    tokenIv: text('token_iv'),
    tokenExpiresAt: timestamp('token_expires_at'),
    lastRefreshAt: timestamp('last_refresh_at'),
    refreshError: text('refresh_error'),
    lastInteraction: timestamp('last_interaction').defaultNow().notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>()
})
