// --------------------------------------------------
// TIME / SCHEDULE
// --------------------------------------------------

function timeToMinutes(time) {
    const [hours, minutes] = String(time).split(':').map(Number)

    if (
        !Number.isInteger(hours) ||
        !Number.isInteger(minutes) ||
        hours < 0 ||
        hours > 23 ||
        minutes < 0 ||
        minutes > 59
    ) {
        return null
    }

    return hours * 60 + minutes
}

function getVietnamTime() {
    const now = new Date()

    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(now)
}

function isWithinSchedule() {
    if (schedule.enabled !== true) {
        return true
    }

    const wake = timeToMinutes(schedule.wakeTime || '06:00')
    const sleep = timeToMinutes(schedule.sleepTime || '23:00')

    if (wake === null || sleep === null) {
        console.warn('[SCHEDULE] Invalid schedule. Schedule disabled.')
        return true
    }

    const vietnamTime = getVietnamTime()

    const [hours, minutes] = vietnamTime
        .split(':')
        .map(Number)

    const current = hours * 60 + minutes

    if (wake < sleep) {
        return current >= wake && current < sleep
    }

    return current >= wake || current < sleep
}

function getScheduleState() {
    if (schedule.enabled !== true) {
        return 'always-on'
    }

    return isWithinSchedule()
        ? 'awake'
        : 'sleeping'
}
