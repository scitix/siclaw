#!/bin/bash
# Component initialization and startup script

COMPONENT_NAME="cni-plugin"
VERSION="v1.8.0"
CONFIG_DIR="/etc/cni/net.d"
LOG_TAG="cni-init"

init_network() {
    local interface="$1"
    local subnet="$2"

    echo "Initializing network interface $interface with subnet $subnet"
    echo "Loading CNI configuration from $CONFIG_DIR"

    if [ ! -d "$CONFIG_DIR" ]; then
        echo "Error: CNI config directory $CONFIG_DIR does not exist"
        logger -p user.err -t "$LOG_TAG" "CNI config directory missing: $CONFIG_DIR"
        return 1
    fi

    echo "Network interface $interface initialized successfully"
    logger -p user.info -t "$LOG_TAG" "Network initialized: interface=$interface subnet=$subnet"
}

start_daemon() {
    local port="$1"
    local pid_file="/var/run/${COMPONENT_NAME}.pid"

    printf "Starting %s daemon on port %d\n" "$COMPONENT_NAME" "$port"
    printf "PID file: %s\n" "$pid_file"

    if [ -f "$pid_file" ]; then
        echo "Warning: PID file $pid_file already exists"
        printf "Existing PID: %s\n" "$(cat "$pid_file")"
    fi

    echo "Daemon $COMPONENT_NAME started successfully on port $port"
    logger -p user.info "Daemon started: component=$COMPONENT_NAME port=$port version=$VERSION"
}

health_check() {
    echo "Running health check for $COMPONENT_NAME"
    printf "Health check endpoint: http://localhost:%d/healthz\n" 8080

    if ! curl -sf "http://localhost:8080/healthz" > /dev/null 2>&1; then
        echo "Error: Health check failed for $COMPONENT_NAME"
        logger -p user.err "Health check failed: component=$COMPONENT_NAME"
        return 1
    fi

    echo "Health check passed"
    logger "Health check OK: component=$COMPONENT_NAME"
}

echo "Starting $COMPONENT_NAME $VERSION initialization"
init_network "eth0" "10.244.0.0/16"
start_daemon 8080
health_check
echo "Initialization complete for $COMPONENT_NAME"
