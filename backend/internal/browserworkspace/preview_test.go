package browserworkspace

import "testing"

const testPrefix = "/v1/workspace/abc/preview/proxy/"

func TestRewriteSubpath_HTML(t *testing.T) {
	in := `<html><head>` +
		`<script type="module" src="/@vite/client"></script>` +
		`<link rel="stylesheet" href="/src/index.css">` +
		`</head><body></body></html>`
	got := string(rewriteSubpath([]byte(in), "text/html", testPrefix))

	want := `<html><head>` +
		`<script type="module" src="/v1/workspace/abc/preview/proxy/@vite/client"></script>` +
		`<link rel="stylesheet" href="/v1/workspace/abc/preview/proxy/src/index.css">` +
		`</head><body></body></html>`
	if got != want {
		t.Fatalf("HTML rewrite mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestRewriteSubpath_JS(t *testing.T) {
	in := `import { render } from "/node_modules/.vite/deps/react.js";` +
		`import "/src/main.jsx";` +
		`const mod = import("/src/App.jsx");`
	got := string(rewriteSubpath([]byte(in), "application/javascript", testPrefix))

	want := `import { render } from "/v1/workspace/abc/preview/proxy/node_modules/.vite/deps/react.js";` +
		`import "/v1/workspace/abc/preview/proxy/src/main.jsx";` +
		`const mod = import("/v1/workspace/abc/preview/proxy/src/App.jsx");`
	if got != want {
		t.Fatalf("JS rewrite mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestRewriteSubpath_CSS(t *testing.T) {
	in := `body { background: url("/img/bg.png"); }` +
		`@import "/theme/base.css";`
	got := string(rewriteSubpath([]byte(in), "text/css", testPrefix))

	want := `body { background: url("/v1/workspace/abc/preview/proxy/img/bg.png"); }` +
		`@import "/v1/workspace/abc/preview/proxy/theme/base.css";`
	if got != want {
		t.Fatalf("CSS rewrite mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestRewriteSubpath_LeavesSafeURLsUntouched(t *testing.T) {
	in := `<a href="https://example.com/x">ext</a>` +
		`<img src="data:image/png;base64,AAA">` +
		`<a href="/v1/workspace/abc/preview/proxy/src/main.jsx">already</a>` +
		`<p>const from = "/not-a-module"; // string literal is left alone? no — it matches from "/..."</p>`
	got := string(rewriteSubpath([]byte(in), "text/html", testPrefix))

	// Absolute scheme URLs and data: URIs must be untouched.
	if !contains(got, `href="https://example.com/x"`) {
		t.Errorf("https URL was modified: %s", got)
	}
	if !contains(got, `src="data:image/png;base64,AAA"`) {
		t.Errorf("data: URI was modified: %s", got)
	}
	// Already-prefixed URL must stay byte-identical (no double prefixing).
	wantPrefixed := `<a href="` + testPrefix + `src/main.jsx">already</a>`
	if !contains(got, wantPrefixed) {
		t.Errorf("already-prefixed URL was modified:\n got: %s\nwant substring: %s", got, wantPrefixed)
	}
	if contains(got, testPrefix+testPrefix) {
		t.Errorf("already-prefixed URL was double-prefixed: %s", got)
	}
}

func TestRewriteSubpath_EmptyPrefixIsNoop(t *testing.T) {
	in := `<script src="/@vite/client"></script>`
	if got := string(rewriteSubpath([]byte(in), "text/html", "")); got != in {
		t.Fatalf("empty prefix should be a noop, got: %s", got)
	}
}

func TestRewriteSubpath_UnknownContentTypeIsNoop(t *testing.T) {
	in := `import "/src/x.js"`
	if got := string(rewriteSubpath([]byte(in), "application/octet-stream", testPrefix)); got != in {
		t.Fatalf("unknown content type should be a noop, got: %s", got)
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
