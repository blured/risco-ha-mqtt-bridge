const request = require('request-promise-native');

const ARMED = 3
const DISARMED = 1
const PARTIALLY_ARMED = 2

// Maps the cloud API's system-wide `systemStatus` field (GetState) to the
// old per-partition armedState enum this app publishes to HA, since the
// `partitions` array is no longer populated (see getState below).
const SYSTEM_STATUS_TO_ARMED_STATE = { 0: DISARMED, 1: PARTIALLY_ARMED, 4: ARMED }

const LOGIN = 'https://www.riscocloud.com/webapi/api/auth/login'
const GET_ALL = 'https://www.riscocloud.com/webapi/api/wuws/site/GetAll'

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

const setAlarm = async (accessToken, sessionToken, siteId, status, partitionId = 0) => {
    // This panel doesn't support partitions - PartArm returns
    // errorText: "The control panel does not support partitions. You need
    // to use the Arm action to perform arming operations." Use the
    // whole-panel Arm endpoint instead.
    const CONTROL_PANEL = `https://www.riscocloud.com/webapi/api/wuws/site/${siteId}/ControlPanel/Arm`

    let result = await request({
        method: 'POST',
        url: CONTROL_PANEL,
        json: true,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
        },
        body: {
            "armedState": status,
            "sessionToken": `${sessionToken}`
        }
    })

    if (result.status === 401) throw createUnauthorizedError(result.errorText)
    if (result.result !== 0) throw new Error(result.errorText || `Arm request failed with result code ${result.result}`)

    let response = result.response

    const partitions = (!response || !response.partitions) ? [] : response.partitions
    const zones = (!response || !response.zones) ? [] : response.zones
    return { partitions, zones }
}

module.exports = (config) => {
    let accessToken, sessionId, siteId, logged
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

    const _setAlarmState = async (state, partitionId) => {
        if (!logged) await _login()
        return setAlarm(accessToken, sessionId, siteId, state, partitionId).catch(error => {
            if (error.statusCode === 401) {
                console.log('refreshing login due to session expired or invalid token during setting alarm state')
                logged = false;
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
