const mineflayer = require('mineflayer')
const express = require('express')
const fs = require('fs')
const path = require('path')

const setupLeaveRejoin = require('./leaveRejoin')

const SETTINGS_PATH = path.join(__dirname, 'settings.json')

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    } catch (err) {
        console.error('[CONFIG] Cannot read settings.json:', err.message)
        process.exit(1)
    }
}

const settings = loadSettings()

const server = settings.server || {}
const botSettings = settings.bot || {}
const schedule = settings.schedule || {}
const webSettings = settings.web || {}

let bot = null
let reconnectTimer = null
let scheduleTimer = null

let intentionallySleeping = false
let creatingBot = false
let reconnectAttempts = 0

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
// --------------------------------------------------
// RECONNECT
// --------------------------------------------------

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }
}

function scheduleReconnect(reason = 'unknown') {
    if (intentionallySleeping) {
        console.log('[AFK] Reconnect skipped: scheduled sleep.')
        return
    }

    if (!isWithinSchedule()) {
        console.log('[AFK] Reconnect skipped: outside active schedule.')
        return
    }

    clearReconnectTimer()

    reconnectAttempts++

    let delay = Number(botSettings.reconnectDelay) || 10000

    // Small backoff after repeated failures
    if (reconnectAttempts > 3) {
        delay = Math.min(delay * 2, 60000)
    }

    console.log(
        `[AFK] Reconnecting in ${Math.ceil(delay / 1000)}s ` +
        `(reason: ${reason}, attempt: ${reconnectAttempts})`
    )

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null

        if (!isWithinSchedule()) {
            console.log('[AFK] Reconnect cancelled: outside schedule.')
            return
        }

        createBot()
    }, delay)
}

// --------------------------------------------------
// BOT
// --------------------------------------------------

function destroyCurrentBot() {
    if (!bot) return

    const oldBot = bot
    bot = null

    try {
        oldBot.removeAllListeners()
    } catch (_) {}

    try {
        oldBot.quit()
    } catch (_) {}
}

function createBot() {
    if (creatingBot) {
        console.log('[AFK] Bot creation already in progress.')
        return
    }

    if (intentionallySleeping) {
        console.log('[AFK] Bot is sleeping.')
        return
    }

    if (!isWithinSchedule()) {
        console.log('[AFK] Outside active schedule.')
        return
    }

    if (bot) {
        console.log('[AFK] Bot already exists.')
        return
    }

    creatingBot = true

    console.log('[AFK] Creating Minecraft bot...')
    console.log(`[AFK] Server: ${server.host}:${server.port}`)
    console.log(`[AFK] Username: ${botSettings.username}`)

    const options = {
        host: server.host,
        port: Number(server.port) || 25565,
        username: botSettings.username || 'AFK_Bot'
    }

    if (
        server.version &&
        server.version !== 'auto'
    ) {
        options.version = server.version
    }

    try {
        bot = mineflayer.createBot(options)
    } catch (err) {
        creatingBot = false

        console.error('[AFK] Failed to create bot:', err.message)

        bot = null
        scheduleReconnect('createBot-error')
        return
    }

    creatingBot = false

    const currentBot = bot

    // ----------------------------------------------
    // SPAWN
    // ----------------------------------------------

    currentBot.once('spawn', () => {
        if (bot !== currentBot) return

        reconnectAttempts = 0

        console.log('[AFK] ===============================')
        console.log('[AFK] BOT CONNECTED')
        console.log(`[AFK] Username: ${currentBot.username}`)
        console.log(`[AFK] Schedule: ${getScheduleState()}`)
        console.log('[AFK] ===============================')
    })

    // ----------------------------------------------
    // MESSAGE
    // ----------------------------------------------

    currentBot.on('message', (message) => {
        console.log(`[MC] ${message.toString()}`)
    })

    // ----------------------------------------------
    // KICK
    // ----------------------------------------------

    currentBot.on('kicked', (reason) => {
        console.log('[AFK] Bot kicked:', reason)

        if (bot === currentBot) {
            bot = null
        }

        if (!intentionallySleeping) {
            scheduleReconnect('kicked')
        }
    })

    // ----------------------------------------------
    // ERROR
    // ----------------------------------------------

    currentBot.on('error', (err) => {
        console.error('[AFK] Minecraft error:', err.message)

        if (bot === currentBot) {
            bot = null
        }

        if (!intentionallySleeping) {
            scheduleReconnect('error')
        }
    })

    // ----------------------------------------------
    // END
    // ----------------------------------------------

    currentBot.on('end', () => {
        console.log('[AFK] Connection ended.')

        if (bot === currentBot) {
            bot = null
        }

        if (!intentionallySleeping) {
            scheduleReconnect('end')
        }
    })

    // ----------------------------------------------
    // EXISTING leaveRejoin.js
    // ----------------------------------------------

    try {
        setupLeaveRejoin(currentBot, createBot)
    } catch (err) {
        console.error(
            '[AFK] leaveRejoin.js error:',
            err.message
        )
    }
}

// --------------------------------------------------
// SCHEDULE MANAGER
// --------------------------------------------------

function sleepBot() {
    if (intentionallySleeping) return

    intentionallySleeping = true

    console.log('[SCHEDULE] Sleep period started.')

    clearReconnectTimer()

    if (bot) {
        const oldBot = bot
        bot = null

        try {
            oldBot.quit()
        } catch (_) {}
    }
}

function wakeBot() {
    if (!intentionallySleeping) {
        if (!bot && isWithinSchedule()) {
            createBot()
        }

        return
    }

    intentionallySleeping = false

    console.log('[SCHEDULE] Active period started.')

    if (!bot && isWithinSchedule()) {
        createBot()
    }
}

function checkSchedule() {
    if (schedule.enabled !== true) {
        if (!bot && !intentionallySleeping) {
            createBot()
        }

        return
    }

    const active = isWithinSchedule()

    if (active) {
        wakeBot()
    } else {
        sleepBot()
    }
}

// --------------------------------------------------
// WEB SERVER
// --------------------------------------------------

function startWebServer() {
    if (webSettings.enabled !== true) {
        console.log('[WEB] Web server disabled.')
        return
    }

    const app = express()

    app.get('/', (req, res) => {
        res.json({
            status: 'online',
            bot: bot
                ? 'connected'
                : 'disconnected',
            schedule: getScheduleState(),
            uptime: process.uptime()
        })
    })

    app.get('/status', (req, res) => {
        res.json({
            connected: !!bot,
            username: bot?.username || null,
            server: `${server.host}:${server.port}`,
            schedule: getScheduleState(),
            sleeping: intentionallySleeping,
            reconnectAttempts
        })
    })

    const port =
        Number(process.env.PORT) ||
        Number(webSettings.port) ||
        3000

    app.listen(port, '0.0.0.0', () => {
        console.log(`[WEB] HTTP server listening on port ${port}`)
    })
}

// --------------------------------------------------
// SHUTDOWN
// --------------------------------------------------

function shutdown(signal) {
    console.log(`[SYSTEM] Received ${signal}. Shutting down...`)

    intentionallySleeping = true

    clearReconnectTimer()

    if (scheduleTimer) {
        clearInterval(scheduleTimer)
        scheduleTimer = null
    }

    if (bot) {
        try {
            bot.quit()
        } catch (_) {}
    }

    setTimeout(() => {
        process.exit(0)
    }, 1000)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
    console.error('[SYSTEM] Uncaught exception:', err)
})

process.on('unhandledRejection', (err) => {
    console.error('[SYSTEM] Unhandled rejection:', err)
})

// --------------------------------------------------
// START
// --------------------------------------------------

console.log('================================')
console.log('   PERZAAN AFK BOT v2')
console.log('================================')

console.log(`[CONFIG] Server: ${server.host}:${server.port}`)
console.log(`[CONFIG] Schedule enabled: ${schedule.enabled}`)
console.log(
    `[CONFIG] Active time: ${schedule.wakeTime} -> ${schedule.sleepTime}`
)

startWebServer()

checkSchedule()

// Check schedule every 30 seconds
scheduleTimer = setInterval(() => {
    checkSchedule()
}, 30000)
