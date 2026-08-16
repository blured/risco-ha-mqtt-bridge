const request = require('request-promise-native');

const ARMED = 3
const DISARMED = 1
const PARTIALLY_ARMED = 2

const LOGIN = 'https://www.riscocloud.com/webapi/api/auth/login'
const GET_ALL = 'https://www.riscocloud.com/webapi/api/wuws/site/GetAll'

// The modern wuws API is only used for login and zone status now. Its
// ControlPanel/Arm endpoint accepts requests (result:0) without ever
// actually changing the panel's state, and its GetState systemStatus field
// doesn't reliably distinguish partial vs full arm on this panel (both
// reported systemStatus:2 in testing). The legacy cookie-based web portal
// (webui.riscocloud.com) works reliably for both arm/disarm commands and
// arm-state reporting (confirmed by capturing its real requests), so it's
// used for those instead.
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

const getZoneState = async (accessToken, sessionToken, siteId) => {
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

    let status = result.response && result.response.state && result.response.state.status
    return (status && status.zones) ? status.zones : []
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

// wuws's systemStatus field doesn't reliably distinguish partial vs full
// arm on this panel (both reported systemStatus:2 in testing), but the
// legacy portal's own partInfo strings are unambiguous. Use them as the
// source of truth for arm state.
const parseLegacyPartInfo = (partInfo) => {
    if (!partInfo) return null
    const isYes = str => typeof str === 'string' && str.trim() === 'Yes'
    if (isYes(partInfo.armedStr)) return ARMED
    if (isYes(partInfo.partarmedStr)) return PARTIALLY_ARMED
    if (isYes(partInfo.disarmedStr)) return DISARMED
    return null
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

    if (result.statusCode === 401 || result.statusCode === 403) throw createUnauthorizedError(`legacy session expired (status ${result.statusCode})`)
    if (result.statusCode >= 400) throw new Error(`legacy ArmDisarm failed with status ${result.statusCode}: ${result.body}`)
}

const legacyGetCPState = async (jar) => {
    // Security/GetCPState returns overview:null on its own - the dashboard's
    // own JS fetches partInfo via a separate call to Overview/Get instead
    // (ArmDisarm's response happens to bundle its own overview refresh,
    // which is why that one looked like it had partInfo).
    const result = await request({
        method: 'POST',
        url: `${LEGACY_BASE}/Overview/Get`,
        jar,
        form: {},
        resolveWithFullResponse: true,
        simple: false
    })

    if (result.statusCode === 401 || result.statusCode === 403) throw createUnauthorizedError(`legacy session expired (status ${result.statusCode})`)
    if (result.statusCode >= 400) throw new Error(`legacy Overview/Get failed with status ${result.statusCode}: ${result.body}`)

    const body = JSON.parse(result.body)

    // TEMP DEBUG: verifying Overview/Get's response shape actually has
    // partInfo before removing this.
    console.log(`DEBUG Overview/Get body: ${result.body}`)

    const armedState = parseLegacyPartInfo(body.overview && body.overview.partInfo)
    if (!armedState) {
        return []
    }
    return [{ id: 0, armedState }]
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
        if (!legacyLogged) await _legacyLogin()

        return legacyGetCPState(legacyJar).catch(error => {
            if (error.statusCode === 401) {
                console.log('refreshing legacy session due to expiry retrieving partitions')
                legacyLogged = false
                return getPartitions()
            }
            throw new Error(error)
        })
    }

    const getZones = async () => {
        if (!logged) await _login()
        return getZoneState(accessToken, sessionId, siteId).catch(error => {
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
