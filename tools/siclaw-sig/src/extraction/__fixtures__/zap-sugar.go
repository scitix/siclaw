package client

import "go.uber.org/zap"

func Connect(sugar *zap.SugaredLogger, host string, port int) {
	// Printf style
	sugar.Infof("Connecting to %s:%d", host, port)
	sugar.Warnf("Connection to %s is slow: %dms latency", host, latency)
	sugar.Errorf("Failed to connect to %s:%d: %v", host, port, err)

	// Structured style (w-suffix)
	sugar.Infow("Connection established", "host", host, "port", port)
	sugar.Warnw("High latency detected", "host", host, "latency_ms", latency)
	sugar.Errorw("Connection lost", "host", host, "reason", "timeout")
}
