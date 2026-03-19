import logging

logger = logging.getLogger(__name__)


def connect_to_database(host: str, port: int) -> None:
    logger.info("Connecting to database at %s:%d", host, port)
    logger.warning("Connection attempt %d of %d", 1, 3)
    logger.error("Failed to connect to %s: %s", host, "connection refused")


def process_request(request_id: str) -> None:
    logging.info("Processing request %s", request_id)
    logging.warning("Request %s took longer than expected", request_id)
    logging.error("Request %s failed: %s", request_id, "timeout")
    logging.debug("Request payload: %s", request_id)


def start_server(port: int) -> None:
    logger.info(f"Server starting on port {port}")
    logger.info("Server started successfully on port %d", port)
    logger.critical("Server failed to start: %s", "address in use")


def health_check() -> None:
    logging.info("Health check passed")
    logger.warning("Health check degraded: %s", "high latency")
