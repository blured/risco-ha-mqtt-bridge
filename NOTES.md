# risco-ha-mqtt-bridge — Notes

## What this app does

**risco-ha-mqtt-bridge** is a Node.js bridge process that sits between a RISCO
alarm panel (accessed via RISCO's cloud REST API — the same one their iRISCO mobile
app uses) and an MQTT broker, structured so Home Assistant can automatically
discover and control the alarm panel and its sensors. It's a translation/polling
layer: RISCO doesn't push events to you, so this app polls RISCO's cloud on an
interval and re-publishes whatever it finds as MQTT messages in a schema Home
Assistant understands.

### 1. Startup and entry point

- `bin/risco-ha-mqtt-bridge.js` is the CLI entrypoint (invoked via
  `npx risco-ha-mqtt-bridge`). It looks for a `config.json` in the current
  working directory, `require()`s it as plain JSON, and passes it into the exported
  function from `index.js`. If the file is missing or invalid JSON, it logs an
  error and exits with code 1.
- `index.js` exports a single factory function `(config) => {...}` that
  destructures the config (username, password, pin, language-id, mqtt-url,
  mqtt-username/password, and two optional settings with defaults:
  `home-assistant-discovery-prefix` = `homeassistant`, `interval-polling` =
  `5000`ms). It throws synchronously if any required field is missing.

### 2. Two clients are created

- **`riscoClient`** — from the separate `node-risco-client` npm package. This
  wraps RISCO's cloud REST API (`https://www.riscocloud.com/webapi/...`), not the
  local panel — everything goes through RISCO's servers.
- **`mqttClient`** — a standard `mqtt.js` client connected to your broker.

### 3. How RISCO authentication works (in the dependency)

`node-risco-client`'s login sequence (triggered lazily on first API call, and
again automatically on any 401):
1. `POST /api/auth/login` with username/password → returns an `accessToken`.
2. `POST /api/wuws/site/GetAll` with that bearer token → returns the list of
   sites; it takes `response[0].id` as the `siteId` (only really supports a
   single-site account — the first one returned).
3. `POST /api/wuws/site/{siteId}/Login` with the panel PIN and language →
   returns a `sessionId`.

All subsequent calls (`GetState`, `PartArm`, `GetEventLog`) use
`{accessToken, sessionId, siteId}`. A 401 response triggers a transparent
re-login and retry — this repo's code never has to think about token refresh.

### 4. On MQTT `connect`

Fires on initial connect and on every auto-reconnect:
1. Calls `riscoClient.getPartitions()` and `riscoClient.getZones()` in parallel
   (both hit the same `GetState` endpoint under the hood).
2. **`subscribeAlarmStateChange`**: subscribes to `riscopanel/alarm/<partitionId>/set`
   for each partition, and starts a `setInterval` polling loop
   (`retrieveAlarmStatus`) every `interval-polling` ms (default 5s).
3. **`autoDiscovery`**: publishes Home Assistant MQTT-discovery config payloads —
   one `alarm_control_panel` per partition
   (`homeassistant/alarm_control_panel/risco-alarm-panel/<partitionId>/config`)
   and one `binary_sensor` per zone
   (`homeassistant/binary_sensor/<zoneName>/<zoneID>/config`), so entities appear
   in HA automatically with no manual YAML.

### 5. The polling loop — status reporting

Every `interval-polling` ms, `retrieveAlarmStatus`:
- **`publishAlarmStateChange`**: maps each partition's numeric `armedState`
  (1/2/3) to `disarmed`/`armed_home`/`armed_away` and publishes to
  `riscopanel/alarm/<partitionId>/status`.
- **`publishSensorsStateChange`**: publishes the full zone JSON to
  `riscopanel/alarm/<partitionId>/sensor/<zoneID>` (HA `json_attributes_topic`)
  and a simplified `idle`/`triggered` string to `.../sensor/<zoneID>/status`
  (drives the binary_sensor state). Zone→partition mapping uses `zone.part - 1`
  to align RISCO's 1-indexed `part` with the 0-indexed `partition.id`.

### 6. Commands from Home Assistant — arm/disarm

HA publishes a command string (`DISARM`, `ARM_HOME`, `ARM_NIGHT`, `ARM_AWAY`) to
`riscopanel/alarm/<partitionId>/set`. The MQTT `message` handler extracts the
partition ID from the topic, looks up the matching function in an `alarmAction`
map (`ARM_HOME` and `ARM_NIGHT` both map to `partiallyArm` — RISCO doesn't
distinguish them), calls the corresponding `riscoClient` method (which POSTs to
RISCO's `PartArm` endpoint), then optimistically republishes the new state to
`.../status` ahead of the next poll cycle.

### 7. Net effect

Home Assistant sees a normal MQTT alarm control panel plus MQTT binary sensors,
fully auto-discovered. Nothing is realtime/push — it's a 5-second (configurable)
poll of RISCO's cloud translated into MQTT, and commands are REST calls fired in
response to MQTT messages. Stateless between restarts, single-account/single-site
only (dependency assumes `response[0].id`).

---

## Bugs found and fixed (2026-08-15)

Source reviewed: `index.js` (143 lines), cross-checked against the installed
`node-risco-client` dependency source to confirm actual API behavior.

1. **Multi-partition control was broken (high severity).**
   `disarm`/`arm`/`partiallyArm` received a `partitionId` argument but never
   forwarded it to `riscoClient.disarm()/arm()/partiallyArm()`. The underlying
   library defaults `partitionId` to `0` when omitted, so every arm/disarm
   command always targeted partition 0 regardless of which partition's topic
   triggered it — contradicting the README's multi-partition support claim.
   **Fix:** pass `partitionId` through to all three calls.

2. **Polling interval leaked on every MQTT reconnect (medium-high).**
   `subscribeAlarmStateChange` (re-run on every `connect` event, including
   auto-reconnects) called `setInterval(retrieveAlarmStatus, ...)` with no
   matching `clearInterval`, so timers stacked up after each reconnect, causing
   duplicate/multiplying API calls and MQTT publishes over time.
   **Fix:** track the interval handle in a module-level variable and
   `clearInterval` before creating a new one.

3. **Partition-ID regex broke for IDs ≥ 10 (medium).**
   `/^riscopanel\/alarm\/([0-9])*\/set$/m` applied `*` to the whole capture
   group rather than the digit class, so only the last digit of a multi-digit
   ID was captured (e.g. `.../12/set` captured `"2"`).
   **Fix:** changed to `([0-9]+)`.

4. **`arm()` resolved the wrong status string (low).**
   Returned `'armed_home'` (copy-pasted from `partiallyArm`) instead of
   `'armed_away'`. Only affected the console log message, not the actual MQTT
   publish. **Fix:** corrected to `'armed_away'`.

5. **No `error` listener on the MQTT client (medium).**
   An unhandled `'error'` event on a Node `EventEmitter` throws and crashes the
   process — a bad password, unreachable broker, or TLS failure would kill the
   app with no useful log. **Fix:** added `mqttClient.on('error', ...)`.

6. **`zoneName.replace(' ', '-')` only replaced the first space (low).**
   `String.replace` with a plain string pattern (no `/g`) replaces only the
   first match, so multi-word zone names (e.g. `"Front Door Sensor"`) produced
   an HA discovery `node_id` still containing a space. **Fix:** changed to
   `.replace(/ /g, '-')`.

Also converted the topic-derived `partitionId` (a string from the regex match)
to a `Number` before dispatching commands, since the RISCO API expects a
numeric partition id matching the type used elsewhere (`partition.id`).

### Resolved since (2026-08-15)

- Risco's cloud `GetState` API stopped populating `state.status.partitions`
  (returns `null`) at some point after this wrapper was last updated. Fixed
  by deriving arm state from the still-present system-wide `systemStatus`
  field instead (`lib/risco-client.js`): `0` disarmed, `1` armed_home,
  `4` armed_away. See `lib/risco-client.js` for details.
- Both discovery payloads now set `unique_id` (`risco-alarm-panel-<partition>`
  style for the panel, `risco-zone-<zoneID>` for sensors), and the alarm
  panel disables `code_arm_required`/`code_disarm_required` and restricts
  `supported_features` to the two states this app actually reports.
- Arm/disarm commands used the `PartArm` endpoint, which this panel's cloud
  API rejects with `errorText: "The control panel does not support
  partitions. You need to use the Arm action to perform arming operations."`
  The suggested `ControlPanel/Arm` endpoint turned out to be a dead end too:
  it accepts any armedState value (`result: 0`, i.e. "success") without ever
  actually changing the panel, and `GetState`'s `systemStatus` field can't
  reliably distinguish partial vs full arm either (both reported the same
  value in testing).
- **Final fix (2026-08-16): arm/disarm and arm-state reporting now go
  through a second, legacy cookie-based API** at `webui.riscocloud.com`
  (Risco's older web portal, distinct from the modern `wuws` API), which
  works reliably for both. See `legacy*` functions in `lib/risco-client.js`
  and the `project-risco-cloud-api-state` memory for the full endpoint
  reference. `wuws` is still used for login and zone status only.
- **Session-expiry bug (2026-08-17):** `legacyArmDisarm`/`legacyGetOverview`
  used `request`'s default redirect-following behavior. When the legacy
  portal's session cookie expires, those endpoints 302-redirect to a login
  page instead of returning 401 - `request` silently followed it, turning
  the expiry into a fake `200` response with an HTML body instead of JSON.
  For `getPartitions` this crashed `JSON.parse` with an error that didn't
  carry `statusCode: 401`, so the existing relogin-and-retry logic never
  triggered and polling just kept failing the same way until the add-on was
  restarted. Fixed by setting `followRedirect: false` on both calls (so a
  3xx surfaces as a real status code) and wrapping the `JSON.parse` in a
  try/catch that also triggers a relogin as a defensive fallback.

### Stopped working (2026-09-26) — legacy portal changed its session-expiry response

**Symptom:** the alarm panel entity stops updating and can't be armed or
disarmed, while the zone binary sensors keep working normally. The add-on log
shows `unrecognized legacy partInfo: null` repeating every poll and never a
relogin line.

**Cause:** the 2026-08-17 fix above assumed an expired legacy session makes
`Overview/Get` and `Security/ArmDisarm` 302-redirect to a login page, and
detected the expiry from the status code. Risco's portal no longer does that —
an unauthenticated call to either endpoint now returns a plain `200` with
`Content-Type: application/json` and a body of `{"error":3,"overview":null}`
(verified 2026-09-26 by calling both endpoints with no session cookie). The
status-code checks therefore never fire, and:

- `legacyGetOverview` parsed that body fine, found `overview` null, logged
  `unrecognized legacy partInfo` and **returned `[]`**. An empty partition list
  is not an error anywhere upstream, so `publishAlarmStateChange` published no
  state, `subscribeAlarmStateChange` subscribed to no command topic, and
  `autoDiscovery` published no `alarm_control_panel` — the panel silently
  disappeared while zones (which come from the separate `wuws` API) kept going.
  Because no 401 was ever raised, the relogin never ran, so the add-on stayed
  broken until restarted.
- `legacyArmDisarm` saw the same `200` and treated it as **success**, so
  `index.js` optimistically published the new state to MQTT. Home Assistant
  showed the arm/disarm as having worked while the panel never moved — the
  more dangerous half of this bug.

**Fixes (`lib/risco-client.js`):**

1. Both legacy endpoints now check the body's `error` field.
   `error: 3` (`LEGACY_ERROR_SESSION_EXPIRED`) raises the 401-style error that
   drives the existing relogin-and-retry; any other non-zero `error` raises a
   plain error instead of being ignored.
2. `legacyGetOverview` no longer returns `[]` on an unparseable overview — a
   missing `overview` or unrecognized `partInfo` now throws, so a future
   response-shape change fails loudly instead of quietly removing the panel.
3. `legacySiteLogin` checks the redirect target. Success 302s to `MainPage`;
   a rejected login 302s to `UserLogin`/`SessionExpired` with the same status
   code, which previously still set `legacyLogged = true`.
4. The relogin recursion in `getPartitions`, `getZones` and `_setAlarmState` is
   capped at one retry. It was unbounded, so a permanently failing login would
   re-login on every 5s poll — and `POST /api/auth/login` enforces a 5-attempt
   lockout (its response carries `currentLoginAttempt`/`maxLoginAttempts`), so
   the old code could lock the Risco account out on its own.
5. The `wuws` login now surfaces the API's `errorText` (e.g. `invalid custom
   credential`) instead of the generic `no accessToken has been returned`,
   since that endpoint returns `200` with the real outcome in the body.

Also replaced `throw new Error(error)` in the three retry handlers with
`throw error` — the old form stringified the error, discarding its
`statusCode` and stack.

6. `retrieveAlarmStatus` now uses `Promise.allSettled` instead of `Promise.all`.
   Partitions come from the legacy portal and zones from the `wuws` API; with
   `getPartitions` able to reject (it previously swallowed the failure and
   returned `[]`), one API being down would otherwise have stopped the zone
   sensors publishing too.

**Confirmed against the live add-on (2026-09-26):** the log was solid
`unrecognized legacy partInfo: null` with zero `refreshing legacy session`
lines, and `alarm_control_panel.risco_alarm_panel_0` was `unavailable` with
`restored: true` while the zone binary sensors stayed live — i.e. the add-on
was running and publishing zones, but `getPartitions()` returned `[]` on every
poll so the panel was never discovered. Discovery payloads are published
without the retain flag, which is why the panel entity disappears entirely
rather than going stale.
