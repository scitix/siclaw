package reconciler

import "github.com/go-logr/logr"

func Reconcile(logger logr.Logger, name string) {
	logger.Info("Starting reconciliation", "name", name, "namespace", "default")
	logger.Error(err, "Failed to reconcile resource", "name", name, "retries", 3)

	// Zero key-value variant
	logger.Info("Reconciliation complete")

	// Chained logger
	log := logger.WithName("sub-reconciler")
	log.Info("Sub-reconciler started", "component", "network")
}
