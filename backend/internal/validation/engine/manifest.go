package engine

import (
	"context"
	"path"

	"gopkg.in/yaml.v3"
)

// The Forge Manifest (`.forge/validation.yaml`) lets a repository explicitly
// declare how it wants to be validated, overriding all inference. It is the top
// rung of the precedence ladder (ProvManifest). In v1 Forge only *proposes* a
// manifest (see ProposeManifest); humans review and commit it — no autonomous
// write-back.
//
// Example:
//
//	version: 1
//	capabilities:
//	  install: { command: ["pnpm", "install"] }
//	  test:    { command: ["pnpm", "run", "test"], timeout: 300 }
//	  lint:    { skip: true }
type Manifest struct {
	Version      int                           `yaml:"version"`
	Capabilities map[string]ManifestCapability `yaml:"capabilities"`
}

// ManifestCapability declares one capability. A command makes it Supported; skip
// makes it explicitly Skipped; an empty entry defers to inference.
type ManifestCapability struct {
	Command []string `yaml:"command,omitempty"`
	Timeout int      `yaml:"timeout,omitempty"`
	Skip    bool     `yaml:"skip,omitempty"`
}

var manifestPaths = []string{".forge/validation.yaml", ".forge/validation.yml"}

// loadManifest reads and parses the manifest for a unit, or nil if absent/invalid.
func loadManifest(ctx context.Context, fs *RepoFS, unitPath string) *Manifest {
	for _, name := range manifestPaths {
		raw, err := fs.ReadFile(ctx, path.Join(unitPath, name))
		if err != nil {
			continue
		}
		var m Manifest
		if yaml.Unmarshal(raw, &m) == nil {
			return &m
		}
	}
	return nil
}

type manifestProvider struct{}

func (manifestProvider) ID() string         { return "manifest" }
func (manifestProvider) Kind() ProviderKind { return KindManifest }
func (manifestProvider) Signals() []Signal {
	return []Signal{{Pattern: ".forge/validation.yaml"}, {Pattern: ".forge/validation.yml"}}
}
func (manifestProvider) Detect(ctx context.Context, unit Unit, fs *RepoFS) Claim {
	for _, name := range manifestPaths {
		if ok, _ := fs.Exists(ctx, path.Join(unit.Path, name)); ok {
			return Claim{Relevant: true, Confidence: 1.0, Reason: "forge manifest present"}
		}
	}
	return Claim{}
}
func (p manifestProvider) Resolve(ctx context.Context, cap Capability, unit Unit, fs *RepoFS) []Resolution {
	m := loadManifest(ctx, fs, unit.Path)
	if m == nil {
		return nil
	}
	mc, ok := m.Capabilities[string(cap)]
	if !ok {
		return nil // capability not mentioned → defer to scripts/inference
	}
	if mc.Skip {
		return []Resolution{{
			Capability: cap, State: StateSkipped, Provenance: ProvManifest, Confidence: 1.0,
			Reason: "explicitly skipped by .forge/validation.yaml", ProviderID: p.ID(),
		}}
	}
	if len(mc.Command) == 0 {
		return nil
	}
	return []Resolution{{
		Capability: cap, State: StateSupported, Command: mc.Command, Mode: ModeOneShot,
		TimeoutSec: mc.Timeout, Provenance: ProvManifest, Confidence: 1.0,
		Reason: "defined in .forge/validation.yaml", ProviderID: p.ID(),
	}}
}

// RegisterManifestProvider adds the manifest override provider.
func RegisterManifestProvider(r *Registry) { r.Register(manifestProvider{}) }

// ProposeManifest renders a manifest reflecting the inferred plan, for a human
// to review and commit. This is the v1 "Forge proposes → human commits" flow —
// it never writes the file itself.
func ProposeManifest(plan ValidationPlan) string {
	if len(plan.Units) == 0 {
		return ""
	}
	m := Manifest{Version: 1, Capabilities: map[string]ManifestCapability{}}
	for _, s := range plan.Units[0].Stages {
		if s.State == StateSupported {
			m.Capabilities[string(s.Capability)] = ManifestCapability{
				Command: s.Command,
				Timeout: s.TimeoutSec,
			}
		}
	}
	if len(m.Capabilities) == 0 {
		return ""
	}
	out, err := yaml.Marshal(m)
	if err != nil {
		return ""
	}
	return "# Proposed by Forge — review, adjust, and commit to .forge/validation.yaml\n" +
		"# This overrides Forge's inference for this repository.\n" + string(out)
}
