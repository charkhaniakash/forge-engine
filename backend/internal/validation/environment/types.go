package environment

// FailureOrigin constants
const (
	OriginEnvironment = "environment"
	OriginCode        = "code"
)

// Category constants
const (
	CategoryDiskFull       = "disk_full"
	CategoryOutOfMemory    = "out_of_memory"
	CategoryPermissionDenied = "permission_denied"
	CategoryNetworkFailure = "network_failure"
	CategoryRegistryFailure = "registry_failure"
	CategoryToolMissing    = "tool_missing"
)

// DetectionResult represents the outcome of environment failure detection.
type DetectionResult struct {
	Category      string
	FailureOrigin string
	Confidence    float64
	Message       string
}

// IsFailure returns true if an environment failure was detected.
func (r *DetectionResult) IsFailure() bool {
	return r.Category != ""
}

// Signature defines a pattern-based environment failure signature.
type Signature struct {
	Category      string
	FailureOrigin string
	Confidence    float64
	Patterns      []string
}
