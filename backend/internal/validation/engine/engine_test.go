package engine

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// memFS is an in-memory FileSource for tests. It counts underlying calls so we
// can assert RepoFS actually memoizes (touches the "filesystem" once per path).
type memFS struct {
	files map[string]string // path -> content; dirs are inferred from paths
	reads int
	exts  int
	lists int
}

func (m *memFS) ReadFile(_ context.Context, p string) ([]byte, error) {
	m.reads++
	c, ok := m.files[p]
	if !ok {
		return nil, errors.New("not found")
	}
	return []byte(c), nil
}

func (m *memFS) Exists(_ context.Context, p string) (bool, error) {
	m.exts++
	if _, ok := m.files[p]; ok {
		return true, nil
	}
	// Treat any path that is a prefix of a known file as an existing directory.
	for f := range m.files {
		if strings.HasPrefix(f, p+"/") {
			return true, nil
		}
	}
	return false, nil
}

func (m *memFS) List(_ context.Context, dir string) ([]DirEntry, error) {
	m.lists++
	seen := map[string]bool{}
	var out []DirEntry
	prefix := ""
	if dir != "." {
		prefix = dir + "/"
	}
	for f := range m.files {
		if !strings.HasPrefix(f, prefix) {
			continue
		}
		rest := strings.TrimPrefix(f, prefix)
		if rest == "" {
			continue
		}
		parts := strings.SplitN(rest, "/", 2)
		name := parts[0]
		if seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, DirEntry{Name: name, IsDir: len(parts) > 1})
	}
	return out, nil
}

func TestRepoFS_ReadIsMemoized(t *testing.T) {
	src := &memFS{files: map[string]string{"package.json": `{"name":"x"}`}}
	fs := NewRepoFS(src)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		b, err := fs.ReadFile(ctx, "package.json")
		if err != nil || string(b) != `{"name":"x"}` {
			t.Fatalf("read %d: got %q err %v", i, b, err)
		}
	}
	if src.reads != 1 {
		t.Fatalf("expected 1 underlying read, got %d", src.reads)
	}

	// A successful read should seed Exists for free (no extra underlying call).
	ok, _ := fs.Exists(ctx, "package.json")
	if !ok {
		t.Fatal("expected package.json to exist")
	}
	if src.exts != 0 {
		t.Fatalf("exists should have been served from the read cache, got %d calls", src.exts)
	}
}

func TestRepoFS_GlobBounded(t *testing.T) {
	src := &memFS{files: map[string]string{
		"eslint.config.js":     "",
		"src/a.test.js":        "",
		"src/deep/b.test.js":   "",
		"src/deep/x/c.test.js": "",
	}}
	fs := NewRepoFS(src)
	ctx := context.Background()

	// Depth 0: only root-level matches.
	got, _ := fs.Glob(ctx, ".", "*.config.js", 0)
	if len(got) != 1 || got[0] != "eslint.config.js" {
		t.Fatalf("depth-0 glob: %v", got)
	}

	// Bounded depth stops the walk: c.test.js (depth 3) must not appear at depth 2.
	got, _ = fs.Glob(ctx, ".", "*.test.js", 2)
	joined := strings.Join(got, ",")
	if !strings.Contains(joined, "src/a.test.js") || !strings.Contains(joined, "src/deep/b.test.js") {
		t.Fatalf("expected shallow matches, got %v", got)
	}
	if strings.Contains(joined, "src/deep/x/c.test.js") {
		t.Fatalf("depth bound not respected: %v", got)
	}
}

// stubProvider is a minimal Provider for registry ordering tests.
type stubProvider struct {
	id   string
	kind ProviderKind
}

func (s stubProvider) ID() string          { return s.id }
func (s stubProvider) Kind() ProviderKind  { return s.kind }
func (s stubProvider) Signals() []Signal   { return nil }
func (s stubProvider) Detect(context.Context, Unit, *RepoFS) Claim {
	return Claim{}
}
func (s stubProvider) Resolve(context.Context, Capability, Unit, *RepoFS) []Resolution {
	return nil
}

func TestRegistry_DeterministicOrder(t *testing.T) {
	r := NewRegistry()
	// Register out of order.
	r.Register(stubProvider{id: "node.eslint", kind: KindTool})
	r.Register(stubProvider{id: "node.npm", kind: KindPackageManager})
	r.Register(stubProvider{id: "node.lang", kind: KindLanguage})

	ids := []string{}
	for _, p := range r.Providers() {
		ids = append(ids, p.ID())
	}
	want := "node.eslint,node.lang,node.npm"
	if strings.Join(ids, ",") != want {
		t.Fatalf("order not deterministic: got %v want %s", ids, want)
	}

	tools := r.ByKind(KindTool)
	if len(tools) != 1 || tools[0].ID() != "node.eslint" {
		t.Fatalf("ByKind(tool): %v", tools)
	}
}
