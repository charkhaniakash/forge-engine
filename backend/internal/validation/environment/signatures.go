package environment

// Signatures holds all environment failure signatures.
// These are language-agnostic patterns that indicate infrastructure failures.
var Signatures = []Signature{
	{
		Category:      CategoryDiskFull,
		FailureOrigin: OriginEnvironment,
		Confidence:    1.0,
		Patterns: []string{
			"no space left on device",
			"no space available",
			"disk full",
			"errno 28",
		},
	},
	{
		Category:      CategoryOutOfMemory,
		FailureOrigin: OriginEnvironment,
		Confidence:    1.0,
		Patterns: []string{
			"out of memory",
			"cannot allocate memory",
			"memory exhausted",
			"oom killer",
		},
	},
	{
		Category:      CategoryPermissionDenied,
		FailureOrigin: OriginEnvironment,
		Confidence:    1.0,
		Patterns: []string{
			"permission denied",
			"access denied",
			"errno 13",
		},
	},
	{
		Category:      CategoryNetworkFailure,
		FailureOrigin: OriginEnvironment,
		Confidence:    0.9,
		Patterns: []string{
			"connection refused",
			"connection timed out",
			"network unreachable",
			"dns resolution failed",
			"could not resolve host",
		},
	},
	{
		Category:      CategoryRegistryFailure,
		FailureOrigin: OriginEnvironment,
		Confidence:    0.9,
		Patterns: []string{
			"could not find a version that satisfies the requirement",
			"package not found",
			"404 not found",
			"registry error",
			"unable to fetch",
		},
	},
	{
		Category:      CategoryToolMissing,
		FailureOrigin: OriginEnvironment,
		Confidence:    1.0,
		Patterns: []string{
			"command not found",
			"executable not found",
		},
	},
}
