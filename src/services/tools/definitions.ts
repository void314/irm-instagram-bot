import type { ToolDefinition } from '../llm/openrouter'

export const PRICES_TOOL: ToolDefinition = {
    type: 'function',
    function: {
        name: 'get_prices',
        description:
            'Получить цены на медицинские услуги клиники IRM Clinic по поисковому запросу. ' +
            'Используй когда пользователь спрашивает стоимость услуг, цену, прайс, ' +
            'сколько стоит, тарифы. Вернёт список услуг с ценами.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Поисковый запрос — название услуги или частичное совпадение. ' +
                        'Например: "ЭКО", "приём гинеколога", "спермограмма", "УЗИ"'
                },
                branch_ref1c_id: {
                    type: 'string',
                    description: 'ID филиала в 1С (ref1cId) для фильтрации цен по филиалу'
                },
                branch_name: {
                    type: 'string',
                    description: 'Название филиала (например, "IRM Алматы", "IRM Астана")'
                },
                citizenship: {
                    type: 'string',
                    enum: ['kz', 'foreign'],
                    description:
                        'Гражданство пациента: "kz" — гражданин РК, "foreign" — иностранный гражданин. ' +
                        'Цены отличаются в зависимости от гражданства, поэтому это поле ОБЯЗАТЕЛЬНО. ' +
                        'Если гражданство пациента уже известно из [Информация о пациенте] — используй его. ' +
                        'Если неизвестно — сначала спроси у пользователя гражданство, прежде чем вызывать этот инструмент.'
                }
            },
            required: ['query', 'citizenship']
        }
    }
}

export const SCHEDULE_TOOL: ToolDefinition = {
    type: 'function',
    function: {
        name: 'get_doctor_schedule',
        description:
            'Получить расписание врача IRM Clinic на текущую неделю. ' +
            'Используй когда пользователь хочет записаться к врачу, узнать свободные даты, ' +
            'график работы врача, ближайшую доступную запись.',
        parameters: {
            type: 'object',
            properties: {
                doctor_name: {
                    type: 'string',
                    description:
                        'Имя, фамилия или специализация врача. ' +
                        'Например: "Иванова", "гинеколог", "репродуктолог"'
                }
            },
            required: ['doctor_name']
        }
    }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [PRICES_TOOL, SCHEDULE_TOOL]
