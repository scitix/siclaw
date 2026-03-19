package controller

import "k8s.io/klog/v2"

func reconcilePod(podName string, namespace string) {
	klog.Infof("Starting reconciliation for pod %s/%s", namespace, podName)
	klog.Warningf("Pod %s is in pending state for %d seconds", podName, 120)
	klog.Errorf("Failed to create pod sandbox for pod %q: %v", podName, err)
	klog.Fatalf("Unrecoverable error in controller: %s", err.Error())

	// Verbosity-gated variant
	klog.V(4).Infof("Detailed reconciliation step %d for %s", step, podName)

	// Zero-arg variant
	klog.Infof("Starting full cluster reconciliation")
}
