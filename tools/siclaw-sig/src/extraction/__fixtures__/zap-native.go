package server

import "go.uber.org/zap"

func StartServer(logger *zap.Logger, addr string) {
	logger.Info("Server starting", zap.String("addr", addr), zap.Int("port", 8080))
	logger.Warn("Deprecated config option used", zap.String("option", "legacy-mode"))
	logger.Error("Failed to bind address", zap.String("addr", addr), zap.Error(err))

	// Zero-field variant
	logger.Info("Server ready")
}
