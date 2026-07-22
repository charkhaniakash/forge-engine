package workspace

import "testing"

// Guards the /workspace/workspace duplicate-prefix bug: WriteFile & friends must
// resolve both repo-relative and accidentally-absolute (/workspace/...) paths to
// a single, correct container path.
func TestContainerPath(t *testing.T) {
	cases := []struct{ in, want string }{
		// Repo-relative (the correct input) — unchanged.
		{"src/components/search/index.js", "/workspace/src/components/search/index.js"},
		{"package.json", "/workspace/package.json"},
		// Absolute /workspace path from a tool/LLM — must NOT be doubled.
		{"/workspace/src/components/search/index.js", "/workspace/src/components/search/index.js"},
		{"/workspace/package.json", "/workspace/package.json"},
		// Leading slash without the mount prefix.
		{"/src/a.js", "/workspace/src/a.js"},
		// The container root itself.
		{"/workspace", "/workspace"},
		{"", "/workspace"},
		// A LEGITIMATE relative subdir literally named "workspace" must be preserved.
		{"workspace/foo.js", "/workspace/workspace/foo.js"},
	}
	for _, c := range cases {
		if got := containerPath(c.in); got != c.want {
			t.Errorf("containerPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
