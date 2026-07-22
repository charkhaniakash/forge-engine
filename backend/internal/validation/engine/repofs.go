package engine

import (
	"context"
	"path"
	"sort"
	"strings"
	"sync"
)

// DirEntry is one entry returned by a FileSource listing.
type DirEntry struct {
	Name  string
	IsDir bool
}

// FileSource is the raw, un-cached gateway to a repository's files. It is the
// ONLY thing that actually touches the workspace/container filesystem. A real
// implementation over the workspace manager is wired in Phase 3; tests use an
// in-memory source. All paths are repo-relative and use "/" separators.
type FileSource interface {
	ReadFile(ctx context.Context, path string) ([]byte, error)
	Exists(ctx context.Context, path string) (bool, error)
	List(ctx context.Context, dir string) ([]DirEntry, error)
}

// RepoFS is the Evidence plane: a memoized façade over a FileSource. Every
// component reads repository state through RepoFS so the filesystem is touched
// once per path and detection stays deterministic and cheap. RepoFS is safe for
// concurrent use.
//
// Memoization is per-instance and lives for the lifetime of a single validation
// run (the repository is immutable at a given commit while a run executes).
type RepoFS struct {
	src FileSource

	mu     sync.Mutex
	reads  map[string]readResult
	exists map[string]existResult
	lists  map[string]listResult
}

type readResult struct {
	data []byte
	err  error
}
type existResult struct {
	ok  bool
	err error
}
type listResult struct {
	entries []DirEntry
	err     error
}

// NewRepoFS wraps a FileSource with memoization.
func NewRepoFS(src FileSource) *RepoFS {
	return &RepoFS{
		src:    src,
		reads:  make(map[string]readResult),
		exists: make(map[string]existResult),
		lists:  make(map[string]listResult),
	}
}

// clean normalizes a repo-relative path to a stable cache key.
func clean(p string) string {
	p = strings.TrimPrefix(p, "./")
	p = strings.Trim(p, "/")
	if p == "" {
		return "."
	}
	return path.Clean(p)
}

// ReadFile returns the file's bytes (memoized, including errors).
func (fs *RepoFS) ReadFile(ctx context.Context, p string) ([]byte, error) {
	key := clean(p)
	fs.mu.Lock()
	if r, ok := fs.reads[key]; ok {
		fs.mu.Unlock()
		return r.data, r.err
	}
	fs.mu.Unlock()

	data, err := fs.src.ReadFile(ctx, key)

	fs.mu.Lock()
	fs.reads[key] = readResult{data: data, err: err}
	// A successful read implies existence — seed the exists cache for free.
	if err == nil {
		fs.exists[key] = existResult{ok: true}
	}
	fs.mu.Unlock()
	return data, err
}

// Exists reports whether a path exists (memoized).
func (fs *RepoFS) Exists(ctx context.Context, p string) (bool, error) {
	key := clean(p)
	fs.mu.Lock()
	if r, ok := fs.exists[key]; ok {
		fs.mu.Unlock()
		return r.ok, r.err
	}
	fs.mu.Unlock()

	ok, err := fs.src.Exists(ctx, key)

	fs.mu.Lock()
	fs.exists[key] = existResult{ok: ok, err: err}
	fs.mu.Unlock()
	return ok, err
}

// List returns a directory's immediate entries (memoized).
func (fs *RepoFS) List(ctx context.Context, dir string) ([]DirEntry, error) {
	key := clean(dir)
	fs.mu.Lock()
	if r, ok := fs.lists[key]; ok {
		fs.mu.Unlock()
		return r.entries, r.err
	}
	fs.mu.Unlock()

	entries, err := fs.src.List(ctx, key)

	fs.mu.Lock()
	fs.lists[key] = listResult{entries: entries, err: err}
	fs.mu.Unlock()
	return entries, err
}

// Glob returns repo-relative paths matching pattern (path.Match semantics: `*`
// and `?`, no `**`), searched breadth-first from root up to maxDepth directory
// levels. Bounded by design: providers declare narrow patterns/depths so we
// never walk an entire repository. Results are sorted for determinism.
//
// maxDepth 0 matches only entries directly under root.
func (fs *RepoFS) Glob(ctx context.Context, root, pattern string, maxDepth int) ([]string, error) {
	root = clean(root)
	var out []string

	type node struct {
		dir   string
		depth int
	}
	queue := []node{{dir: root, depth: 0}}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]

		entries, err := fs.List(ctx, n.dir)
		if err != nil {
			// A missing/unreadable directory is not fatal to a glob — skip it.
			continue
		}
		for _, e := range entries {
			rel := e.Name
			if n.dir != "." {
				rel = n.dir + "/" + e.Name
			}
			if ok, _ := path.Match(pattern, rel); ok {
				out = append(out, rel)
			} else if ok, _ := path.Match(pattern, e.Name); ok {
				// Also allow matching on the base name for convenience.
				out = append(out, rel)
			}
			if e.IsDir && n.depth < maxDepth {
				queue = append(queue, node{dir: rel, depth: n.depth + 1})
			}
		}
	}

	sort.Strings(out)
	return out, nil
}
