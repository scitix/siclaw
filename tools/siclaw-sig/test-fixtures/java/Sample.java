package com.example.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class PodController {
    private static final Logger logger = LoggerFactory.getLogger(PodController.class);

    public void reconcilePod(String podName, String namespace) {
        logger.info("Starting reconciliation for pod {}/{}", namespace, podName);
        logger.warn("Pod {} is in pending state for {} seconds", podName, 120);
        logger.error("Failed to create pod sandbox for {}: {}", podName, "timeout");
        logger.debug("Reconciliation step {} for pod {}", 1, podName);
    }

    public void healthCheck() {
        logger.info("Health check passed");
        logger.warn("Health check degraded: {}", "high latency");
    }

    public void startServer(int port) {
        logger.info("Server starting on port {}", port);
        logger.error("Server failed to bind to port {}: {}", port, "address in use");
        logger.trace("Detailed startup diagnostics for port {}", port);
    }
}
