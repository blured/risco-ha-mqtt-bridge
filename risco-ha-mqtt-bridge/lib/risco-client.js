const request = require('request-promise-native');

const ARMED = 3
const DISARMED = 1
const PARTIALLY_ARMED = 2

// Maps the cloud API's system-wide `systemStatus` field (GetState) to the
// old per-partition armedState enum this app publishes to HA, since the
// `partitions` array is no longer populated (see getState below). Both 1
// and 2 have been observed for partial/Perimeter arm (2 confirmed via
// ELArm2, 1 from an earlier physical-panel test) - map both to be safe.
const SYSTEM_STATUS_TO_ARMED_STATE = { 0: DISARMED, 1: PARTIALLY_ARMED, 2: PARTIALLY_ARMED, 4: ARMED }

const LOGIN = 'https://www.riscocloud.com/webapi/api/auth/login'
const GET_ALL = 'https://www.riscocloud.com/webapi/api/wuws/site/GetAll'

// The modern wuws ControlPanel/Arm endpoint returns result:0 (success) for
// this panel without ever actually changing systemStatus - no combination of
// armedState values we tried had any effect except disarm. The legacy
// cookie-based web portal (webui.riscocloud.com) still works reliably for
// arm/disarm (confirmed by capturing its real requests), so arm/disarm
// commands go through it instead. Status polling (getState below) is
// unaffected and keeps using the modern API.
const LEGACY_BASE = 'https://webui.riscocloud.com'
const LEGACY_ARM_TYPE = {
    [DISARMED]: '-1:disarmed',
    [PARTIALLY_ARMED]: 'ELArm2',
    [ARMED]: 'ELArm1'
}

const createUnauthorizedError = message => {
    let err = new Error(message);
    err.statusCode = 401;
    return err
}

const login = async (username, password, pin, languageId) => {
    let response

    ({ response } = await request({
        method: 'POST',
        url: LOGIN,
        json: true,
        body: {
            "userName": `${username}`,
            "password": `${password}`
        }
    }))

    const { accessToken } = response
    if (!accessToken) throw new Error('no accessToken has been returned from login request');

    ({ response } = await request({
        method: 'POST',
        url: GET_ALL,
        json: true,
        body: {},
        headers: {
            'Authorization': `Bearer ${accessToken}`,
        }
    }))

    if (!response || !Array.isArray(response) || response[0] == null || !response[0].id)
        throw new Error('no siteId has been returned from login request');

    const siteId = response[0].id
    const LOGIN_WITH_PIN = `https://www.riscocloud.com/webapi/api/wuws/site/${siteId}/Login`;

    ({ response } = await request({
        method: 'POST',
        url: LOGIN_WITH_PIN,
        json: true,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
        },
        body: {
            "languageId": `${languageId}-${languageId}`,
            "pinCode": `${pin}`
        }
    }))

    if (!response || !response.sessionId) throw new Error('no sessionId has been returned from login request')
    const sessionId = response.sessionId

    return { accessToken, sessionId, siteId }
}

const getState = async (accessToken, sessionToken, siteId) => {
    const GET_STATE = `https://www.riscocloud.com/webapi/api/wuws/site/${siteId}/ControlPanel/GetState`

    let result = await request({
        method: 'POST',
        url: GET_STATE,
        json: true,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
        },
        body: {
            "fromControlPanel": true,
            "sessionToken": `${sessionToken}`
        }
    })

    if (result.status === 401) throw createUnauthorizedError(result.errorText)

    let response = result.response
    let status = response && response.state && response.state.status

    const zones = (status && status.zones) ? status.zones : []

    // Risco's cloud API no longer populates `status.partitions` for this
    // panel/firmware; the only remaining arm-state signal is the system-wide
    // `systemStatus` value. Synthesize a single partition (id 0) from it.
    let partitions
    if (status && Array.isArray(status.partitions) && status.partitions.length) {
        partitions = status.partitions
    } else if (status) {
        const armedState = SYSTEM_STATUS_TO_ARMED_STATE[status.systemStatus]
        if (armedState) {
            partitions = [{ id: 0, armedState }]
        } else {
            console.log(`unrecognized systemStatus value from Risco cloud: ${status.systemStatus}`)
            partitions = []
        }
    } else {
        partitions = []
    }

    return { partitions, zones }
}

const legacyLogin = async (username, password) => {
    const jar = request.jar()
    await request({
        method: 'POST',
        url: `${LEGACY_BASE}/`,
        jar,
        form: { username, password, RememberMe: 'false' },
        resolveWithFullResponse: true,
        simple: false,
        followAllRedirects: true
    })
    return jar
}

const legacySiteLogin = async (jar, siteId, pinCode) => {
    const result = await request({
        method: 'POST',
        url: `${LEGACY_BASE}/SiteLogin`,
        jar,
        form: { SelectedSiteId: siteId, Pin: pinCode },
        resolveWithFullResponse: true,
        simple: false
    })
    if (result.statusCode >= 400) throw createUnauthorizedError(`legacy site login failed with status ${result.statusCode}`)
}

const legacyArmDisarm = async (jar, armedState) => {
    const type = LEGACY_ARM_TYPE[armedState]
    if (!type) throw new Error(`no legacy arm type mapped for armedState ${armedState}`)

    const result = await request({
        method: 'POST',
        url: `${LEGACY_BASE}/Security/ArmDisarm`,
        jar,
        form: { type, bypassZoneId: -1 },
        resolveWithFullResponse: true,
        simple: false
    })

    // TEMP DEBUG: ELArm1 (full arm) is accepted (no error) but the panel
    // settles into armed_home (systemStatus 2) instead of armed_away (4).
    // Need to see the raw response to know why.
    console.log(`DEBUG legacy ArmDisarm sent type=${type}, status=${result.statusCode}, body=${result.body}`)

    if (result.statusCode === 401 || result.statusCode === 403) throw createUnauthorizedError(`legacy session expired (status ${result.statusCode})`)
    if (result.statusCode >= 400) throw new Error(`legacy ArmDisarm failed with status ${result.statusCode}: ${result.body}`)
}

module.exports = (config) => {
    let accessToken, sessionId, siteId, logged
    let legacyJar, legacyLogged
    let { username, password, pin, languageId } = config
    if (!username) throw new Error('username options is required')
    if (!password) throw new Error('password options is required')
    if (!pin) throw new Error('pin options is required')
    if (!languageId) throw new Error('languageId options is required')

    const _login = async () => {
        ({ accessToken, sessionId, siteId } = await login(username, password, pin, languageId))
        logged = true
        return { accessToken, sessionId, siteId }
    }

    const _legacyLogin = async () => {
        if (!logged) await _login()
        legacyJar = await legacyLogin(username, password)
        await legacySiteLogin(legacyJar, siteId, pin)
        legacyLogged = true
    }

    const _setAlarmState = async (state, partitionId) => {
        if (!legacyLogged) await _legacyLogin()
        return legacyArmDisarm(legacyJar, state).catch(error => {
            if (error.statusCode === 401) {
                console.log('refreshing legacy session due to expiry during setting alarm state')
                legacyLogged = false;
                return _setAlarmState(state, partitionId)
            }
            throw new Error(error)
        })
    }

    const getPartitions = async () => {
        if (!logged) await _login()

        return getState(accessToken, sessionId, siteId).then(result => {
            return result.partitions
        }).catch(error => {
            if (error.statusCode === 401) {
                console.log('refreshing login due to session expired or invalid token retrieving partitions')
                logged = false
                return getPartitions()
            }
            throw new Error(error)
        })
    }

    const getZones = async () => {
        if (!logged) await _login()
        return getState(accessToken, sessionId, siteId).then(result => {
            return result.zones
        }).catch(error => {
            if (error.statusCode === 401) {
                console.log('refreshing login due to session expired or invalid token retrieving zones')
                logged = false;
                return getZones()
            }
            throw new Error(error)
        })
    }

    const disarm = async (partitionId) => {
        return _setAlarmState(DISARMED, partitionId)
    }

    const arm = async (partitionId) => {
        return _setAlarmState(ARMED, partitionId)
    }

    const partiallyArm = async (partitionId) => {
        return _setAlarmState(PARTIALLY_ARMED, partitionId)
    }

    return { getPartitions, getZones, disarm, arm, partiallyArm }
}
