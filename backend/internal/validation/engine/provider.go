package engine

import "context"

// ProviderKind categorizes a provider. Kinds let assembly reason about
// providers as a group (e.g. exactly one package manager per unit) without
// hardcoding which concrete providers exist.
type ProviderKind string

const (
	KindLanguage       ProviderKind = "language"
	KindPackageManager ProviderKind = "package_manager"
	KindTool           ProviderKind = "tool"     // linter / test runner / type checker / builder
	KindManifest       ProviderKind = "manifest" // .forge/validation.yaml
)

// Signal is a declarative statement of the files a provider needs to inspect.
// Providers declare their signals so the engine can batch reads through RepoFS
// and no provider scans the filesystem independently — this is what keeps
// inspection cheap and deterministic. Pattern is a RepoFS.Glob pattern relative
// to the unit root.
type Signal struct {
	Pattern  string
	MaxDepth int
}

// Provider is a self-contained unit of knowledge about ONE thing — a language,
// a package manager, a tool, or the manifest. It is the only place
// tool-specific knowledge lives; adding support for a new linter/runner/PM is a
// new Provider registration, never a switch statement or a profile-map edit.
//
// Providers are PURE: given a unit and a RepoFS they return claims/resolutions
// with no side effects, which makes them trivially unit-testable against
// fixture repositories.
type Provider interface {
	// ID is a stable, unique identifier (e.g. "node.eslint"). Used for
	// deterministic ordering and provenance.
	ID() string

	// Kind categorizes the provider.
	Kind() ProviderKind

	// Signals declares the files/globs this provider reads. Advisory: it lets
	// the engine pre-warm RepoFS; providers still read via RepoFS at Detect/
	// Resolve time.
	Signals() []Signal

	// Detect reports whether this provider is relevant to the unit.
	Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim

	// Resolve proposes how to satisfy a capability for the unit. It returns zero
	// or more resolutions (zero == "no opinion"; a Supported resolution == "run
	// this"; an Unsupported/Misconfigured resolution == an explicit, reasoned
	// non-run). Assembly picks the winner across providers.
	Resolve(ctx context.Context, capability Capability, unit Unit, fs *RepoFS) []Resolution
}
