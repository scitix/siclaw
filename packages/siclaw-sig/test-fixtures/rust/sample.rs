use tracing::{error, warn, info, debug, trace};

struct PodController {
    namespace: String,
}

impl PodController {
    fn reconcile_pod(&self, pod_name: &str) {
        info!("Starting reconciliation for pod {}/{}", self.namespace, pod_name);
        warn!("Pod {} is in pending state for {} seconds", pod_name, 120);
        error!("Failed to create pod sandbox for {}: {}", pod_name, "timeout");
        debug!("Reconciliation step {} for pod {}", 1, pod_name);
    }

    fn health_check(&self) {
        info!("Health check passed");
        warn!("Health check degraded: {}", "high latency");
        trace!("Detailed health metrics: {:?}", self);
    }

    fn start_server(&self, port: u16) {
        tracing::info!("Server starting on port {}", port);
        tracing::error!("Server failed to bind to port {}: {}", port, "address in use");
        log::warn!("Fallback logger: port {} unavailable", port);
        log::error!("Critical failure on port {}", port);
    }
}
