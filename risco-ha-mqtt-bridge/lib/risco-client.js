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

// The legacy portal used to 302 to a login page when its session cookie
// expired. It now answers an unauthenticated JSON call with a plain 200 and
// an `error: 3` body instead (`{"error":3,"overview":null}`), so the status
// code alone no longer detects an expiry - the `error` field has to be
// checked too. See the 2026-09-26 entry in NOTES.md.
const LEGACY_ERROR_SESSION_EXPIRED = 3

const createUnauthorizedError = message => {
    let err = new Error(message);
    err.statusCode = 401;
    return err
}

const login = async (username, password, pin, languageId) => {
    let response

    const loginBody = await request({
        method: 'POST',
        url: LOGIN,
        json: true,
        body: {
            "userName": `${username}`,
            "password": `${password}`
        }
    })

    // This endpoint answers 200 even for a rejected login, putting the real
    // outcome in the body. It also counts failures towards a 5-attempt
    // lockout, so log what it actually said rather than a generic failure.
    if (loginBody && loginBody.errorText) {
        throw new Error(`login rejected by risco: ${loginBody.errorText} (attempt ${loginBody.currentLoginAttempt} of ${loginBody.maxLoginAttempts})`)
    }
    response = loginBody && loginBody.response

    const { accessToken } = response || {}
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
    // Unlike ArmDisarm/Overview.Get (JSON APIs), this is a classic MVC form
    // POST that redirects to MainPage on success - don't disable
    // followRedirect here, only the JSON endpoints below need that.
    const result = await request({
        method: 'POST',
        url: `${LEGACY_BASE}/SiteLogin`,
        jar,
        form: { SelectedSiteId: siteId, Pin: pinCode },
        resolveWithFullResponse: true,
        simple: false
    })
    if (result.statusCode >= 400) throw createUnauthorizedError(`legacy site login failed with status ${result.statusCode}`)

    // A successful site login 302s to the portal's MainPage; a rejected one
    // (bad pin, locked account) sends us back to the login page instead, with
    // the same 302 status. Without this check a failed login still sets
    // legacyLogged, so every later poll fails, triggers another relogin, and
    // the add-on loops on Risco's login endpoint - which locks the account
    // after 5 failed attempts.
    const location = (result.headers && result.headers.location) || ''
    if (/UserLogin|SessionExpired/i.test(location)) {
        throw new Error(`legacy site login was rejected (redirected to ${location})`)
    }
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
        simple: false,
        // The portal has 302'd to a login page on expiry in the past; don't
        // let request follow that silently and turn it into a fake 200. It
        // currently answers 200 with `error: 3` instead, handled below -
        // keep both paths, the endpoint has changed behaviour once already.
        followRedirect: false
    })

    if (result.statusCode === 401 || result.statusCode === 403 || (result.statusCode >= 300 && result.statusCode < 400)) {
        throw createUnauthorizedError(`legacy session expired (status ${result.statusCode})`)
    }
    if (result.statusCode >= 400) throw new Error(`legacy ArmDisarm failed with status ${result.statusCode}: ${result.body}`)

    // A 200 is not enough on its own: an expired session answers with
    // {"error":3} and no side effect, which used to be reported back to Home
    // Assistant as a successful arm/disarm while the panel never moved.
    let body
    try {
        body = JSON.parse(result.body)
    } catch (e) {
        throw createUnauthorizedError(`legacy ArmDisarm returned non-JSON response: ${e.message}`)
    }
    if (body.error === LEGACY_ERROR_SESSION_EXPIRED) {
        throw createUnauthorizedError('legacy ArmDisarm reported an expired session')
    }
    if (body.error) throw new Error(`legacy ArmDisarm failed with error ${body.error}`)
}

const legacyGetOverview = async (jar) => {
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
        simple: false,
        // Same reasoning as ArmDisarm: don't follow a redirect silently, and
        // check the body's `error` field below for the 200-shaped expiry.
        followRedirect: false
    })

    if (result.statusCode === 401 || result.statusCode === 403 || (result.statusCode >= 300 && result.statusCode < 400)) {
        throw createUnauthorizedError(`legacy session expired (status ${result.statusCode})`)
    }
    if (result.statusCode >= 400) throw new Error(`legacy Overview/Get failed with status ${result.statusCode}: ${result.body}`)

    let body
    try {
        body = JSON.parse(result.body)
    } catch (e) {
        // Defensive fallback: an unexpected non-JSON response (e.g. a login
        // page that slipped through) is treated the same as a session
        // expiry so the caller retries after a fresh login instead of
        // getting stuck failing the same way forever.
        throw createUnauthorizedError(`legacy Overview/Get returned non-JSON response: ${e.message}`)
    }

    if (body.error === LEGACY_ERROR_SESSION_EXPIRED) {
        throw createUnauthorizedError('legacy Overview/Get reported an expired session')
    }
    if (body.error) throw new Error(`legacy Overview/Get failed with error ${body.error}`)
    if (!body.overview) throw new Error('legacy Overview/Get returned no overview')

    const armedState = parseLegacyPartInfo(body.overview.partInfo)
    if (!armedState) {
        // Returning [] here instead of throwing is what made the expiry
        // invisible: an empty partition list publishes no state, subscribes
        // to no command topic and skips autodiscovery, all without an error.
        throw new Error(`unrecognized legacy partInfo: ${JSON.stringify(body.overview.partInfo)}`)
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

    // One relogin per call, not unlimited. A permanently failing login (wrong
    // password, locked account) would otherwise recurse forever, re-logging in
    // on every 5s poll until Risco locks the account after 5 attempts.
    const shouldRetry = (error, attempt) => error.statusCode === 401 && attempt === 0

    const _setAlarmState = async (state, partitionId, attempt = 0) => {
        if (!legacyLogged) await _legacyLogin()
        return legacyArmDisarm(legacyJar, state).catch(error => {
            if (shouldRetry(error, attempt)) {
                console.log('refreshing legacy session due to expiry during setting alarm state')
                legacyLogged = false;
                return _setAlarmState(state, partitionId, attempt + 1)
            }
            throw error
        })
    }

    const getPartitions = async (attempt = 0) => {
        if (!legacyLogged) await _legacyLogin()

        return legacyGetOverview(legacyJar).catch(error => {
            if (shouldRetry(error, attempt)) {
                console.log('refreshing legacy session due to expiry retrieving partitions')
                legacyLogged = false
                return getPartitions(attempt + 1)
            }
            throw error
        })
    }

    const getZones = async (attempt = 0) => {
        if (!logged) await _login()
        return getZoneState(accessToken, sessionId, siteId).catch(error => {
            if (shouldRetry(error, attempt)) {
                console.log('refreshing login due to session expired or invalid token retrieving zones')
                logged = false;
                return getZones(attempt + 1)
            }
            throw error
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
