package scheduler

import "k8s.io/klog/v2"

func schedulePod(podName string, nodeName string) {
	klog.InfoS("Pod scheduled successfully", "pod", podName, "node", nodeName)
	klog.ErrorS(err, "Failed to schedule pod", "pod", podName, "reason", "insufficient resources")

	// Verbosity-gated variant
	klog.V(3).InfoS("Evaluating node fitness", "node", nodeName, "score", score)

	// Zero key-value variant
	klog.InfoS("Scheduler cycle complete")
}
