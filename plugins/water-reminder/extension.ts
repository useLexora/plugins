import type { ExtensionContext } from './lexora'

const scheduleId = 'drink-water'

export function activate(context: ExtensionContext) {
  const { id } = context.extension
  context.subscriptions.add(context.commands.register(`${id}.get`, async () => {
    const schedule = await context.schedules.get(scheduleId)
    return schedule ? { enabled: schedule.enabled, intervalMinutes: schedule.intervalMinutes, nextRunAt: schedule.nextRunAt } : { enabled: false, intervalMinutes: 60, nextRunAt: null }
  }))
  context.subscriptions.add(context.commands.register(`${id}.save`, async ({ arguments: input }) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean' || typeof input.intervalMinutes !== 'number' || !Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 1440)
      throw new Error('EXTENSION_SETTINGS_INVALID')
    const schedule = await context.schedules.set({ id: scheduleId, command: `${id}.notify`, enabled: input.enabled, intervalMinutes: input.intervalMinutes })
    return { enabled: schedule.enabled, intervalMinutes: schedule.intervalMinutes, nextRunAt: schedule.nextRunAt }
  }))
  context.subscriptions.add(context.commands.register(`${id}.notify`, () => context.notifications.show({ title: '该喝水啦', body: '放下手边的事情，喝杯水，稍微活动一下吧。' })))
}
