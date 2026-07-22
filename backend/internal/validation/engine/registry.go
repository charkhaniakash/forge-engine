package engine

import "sort"

// Registry holds the registered providers. It contains no logic — it only
// stores providers and hands them back in a deterministic order (sorted by ID),
// so the same repository always produces the same plan regardless of
// registration order or map iteration.
type Registry struct {
	providers map[string]Provider
}

// NewRegistry creates an empty registry.
func NewRegistry() *Registry {
	return &Registry{providers: make(map[string]Provider)}
}

// Register adds a provider. Registering the same ID twice replaces the earlier
// one (last registration wins) — this is intentional so a deployment can
// override a built-in provider.
func (r *Registry) Register(p Provider) {
	r.providers[p.ID()] = p
}

// Providers returns all providers in deterministic (ID-sorted) order.
func (r *Registry) Providers() []Provider {
	out := make([]Provider, 0, len(r.providers))
	for _, p := range r.providers {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID() < out[j].ID() })
	return out
}

// ByKind returns providers of a given kind in deterministic order.
func (r *Registry) ByKind(kind ProviderKind) []Provider {
	var out []Provider
	for _, p := range r.Providers() {
		if p.Kind() == kind {
			out = append(out, p)
		}
	}
	return out
}
