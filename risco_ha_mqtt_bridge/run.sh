#!/usr/bin/with-contenv bashio

CONFIG_PATH=/usr/src/app/config.json

bashio::log.info "Generating configuration..."

cat <<EOF > "${CONFIG_PATH}"
{
    "username": "$(bashio::config 'username')",
    "password": "$(bashio::config 'password')",
    "pin": "$(bashio::config 'pin')",
    "language-id": "$(bashio::config 'language_id')",
    "mqtt-url": "$(bashio::config 'mqtt_url')",
    "mqtt-username": "$(bashio::config 'mqtt_username')",
    "mqtt-password": "$(bashio::config 'mqtt_password')",
    "home-assistant-discovery-prefix": "$(bashio::config 'discovery_prefix')",
    "interval-polling": $(bashio::config 'interval_polling')
}
EOF

cd /usr/src/app

bashio::log.info "Starting risco-ha-mqtt-bridge..."
exec node bin/risco-ha-mqtt-bridge.js
