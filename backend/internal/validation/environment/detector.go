package environment

import (
	"fmt"
	"strings"
)

// Detector performs environment failure detection.
// It is language-agnostic and works for all stacks.
type Detector struct {
	signatures []Signature
}

// NewDetector creates a new environment failure detector with the default signatures.
func NewDetector() *Detector {
	return &Detector{
		signatures: Signatures,
	}
}

// Detect analyzes the combined output and exit code to detect environment failures.
// Returns nil if no environment failure is detected.
func (d *Detector) Detect(combinedOutput string, exitCode int, stageName string) *DetectionResult {
	combinedLower := strings.ToLower(combinedOutput)

	// Special case: exit code 127 is always a tool_missing failure
	if exitCode == 127 {
		return &DetectionResult{
			Category:      CategoryToolMissing,
			FailureOrigin: OriginEnvironment,
			Confidence:    1.0,
			Message:       fmt.Sprintf("Stage '%s' failed with exit code 127 (command not found). A required tool is missing from the validation container.", stageName),
		}
	}

	// Check all signatures for pattern matches
	for _, sig := range d.signatures {
		if d.matchesSignature(combinedLower, sig) {
			message := d.buildMessage(sig.Category, stageName)
			return &DetectionResult{
				Category:      sig.Category,
				FailureOrigin: sig.FailureOrigin,
				Confidence:    sig.Confidence,
				Message:       message,
			}
		}
	}

	return nil
}

// matchesSignature checks if the combined output matches any pattern in the signature.
func (d *Detector) matchesSignature(combinedLower string, sig Signature) bool {
	for _, pattern := range sig.Patterns {
		if strings.Contains(combinedLower, strings.ToLower(pattern)) {
			return true
		}
	}
	return false
}

// buildMessage generates a human-readable message for the detected failure.
func (d *Detector) buildMessage(category string, stageName string) string {
	switch category {
	case CategoryDiskFull:
		return fmt.Sprintf("Stage '%s' failed due to insufficient disk space. The validation container has run out of storage.", stageName)
	case CategoryOutOfMemory:
		return fmt.Sprintf("Stage '%s' failed due to out-of-memory conditions. The validation container may need more memory.", stageName)
	case CategoryPermissionDenied:
		return fmt.Sprintf("Stage '%s' failed due to permission errors. The validation container may not have the required filesystem permissions.", stageName)
	case CategoryNetworkFailure:
		return fmt.Sprintf("Stage '%s' failed due to network connectivity issues. The validation container may not have network access or the remote service is unavailable.", stageName)
	case CategoryRegistryFailure:
		return fmt.Sprintf("Stage '%s' failed due to package registry errors. The required package may not exist or the registry is unavailable.", stageName)
	case CategoryToolMissing:
		return fmt.Sprintf("Stage '%s' failed because a required tool is missing from the validation container.", stageName)
	default:
		return fmt.Sprintf("Stage '%s' failed due to an environment error: %s.", stageName, category)
	}
}
