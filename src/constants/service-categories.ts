// Фиксированная таксономия категорий услуг клиники IRM.
// ВАЖНО: список зафиксирован сознательно — LLM-классификатор (см.
// src/modules/services/service-classifier.ts) должен выбирать категорию СТРОГО
// из этого списка, а не придумывать новые. Это нужно, чтобы SQL-агрегация
// (GROUP BY / DISTINCT ON category) давала консистентный результат между
// разными прогонами синхронизации каталога услуг.
export const SERVICE_CATEGORIES = [
    'Консультации врачей',
    'УЗИ и функциональная диагностика',
    'Лабораторные анализы',
    'Генетические исследования',
    'Программы ВРТ',
    'Процедуры и манипуляции',
    'Прочие услуги'
] as const

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]

export const DEFAULT_SERVICE_CATEGORY: ServiceCategory = 'Прочие услуги'

export function isServiceCategory(value: unknown): value is ServiceCategory {
    return typeof value === 'string' && (SERVICE_CATEGORIES as readonly string[]).includes(value)
}
