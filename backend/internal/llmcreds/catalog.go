package llmcreds

import "strings"

type ProviderDef struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	DocsURL      string   `json:"docs_url"`
	RequiresKey  bool     `json:"requires_key"`
	DefaultModel string   `json:"default_model"`
	Models       []string `json:"models"`
	Hint         string   `json:"hint"`
}

var Catalog = []ProviderDef{
	{
		ID: "openai", Name: "OpenAI", DocsURL: "https://platform.openai.com/api-keys",
		RequiresKey: true, DefaultModel: "gpt-4o-mini",
		Models: []string{"gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini"},
		Hint:   "Starts with sk-",
	},
	{
		ID: "anthropic", Name: "Anthropic", DocsURL: "https://console.anthropic.com/settings/keys",
		RequiresKey: true, DefaultModel: "claude-3-5-sonnet-20241022",
		Models: []string{"claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"},
		Hint:   "Starts with sk-ant-",
	},
	{
		ID: "gemini", Name: "Google Gemini", DocsURL: "https://aistudio.google.com/apikey",
		RequiresKey: true, DefaultModel: "gemini-2.5-flash",
		Models: []string{"gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro"},
		Hint:   "Starts with AIza",
	},
	{
		ID: "groq", Name: "Groq", DocsURL: "https://console.groq.com/keys",
		RequiresKey: true, DefaultModel: "llama-3.3-70b-versatile",
		Models: []string{"llama-3.3-70b-versatile", "llama-3.1-8b-instant", "openai/gpt-oss-20b", "qwen/qwen3-32b"},
		Hint:   "Starts with gsk_",
	},
	{
		ID: "openrouter", Name: "OpenRouter", DocsURL: "https://openrouter.ai/keys",
		RequiresKey: true, DefaultModel: "openai/gpt-4o-mini",
		Models: []string{"openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001", "nvidia/nemotron-3-nano-30b-a3b:free"},
		Hint:   "Starts with sk-or-",
	},
	{
		ID: "mistral", Name: "Mistral", DocsURL: "https://console.mistral.ai/api-keys",
		RequiresKey: true, DefaultModel: "mistral-medium-latest",
		Models: []string{"mistral-medium-latest", "mistral-large-latest", "codestral-latest"},
		Hint:   "Mistral console API key",
	},
	{
		ID: "cohere", Name: "Cohere", DocsURL: "https://dashboard.cohere.com/api-keys",
		RequiresKey: true, DefaultModel: "command-r-plus-08-2024",
		Models: []string{"command-r-plus-08-2024", "command-a-03-2025", "command-light"},
		Hint:   "Cohere dashboard API key",
	},
	{
		ID: "tokenrouter", Name: "TokenRouter", DocsURL: "https://tokenrouter.io",
		RequiresKey: true, DefaultModel: "moonshotai/kimi-k3-free",
		Models: []string{"moonshotai/kimi-k3-free"},
		Hint:   "TokenRouter API key",
	},
	{
		ID: "ollama", Name: "Ollama (local)", DocsURL: "https://ollama.com",
		RequiresKey: false, DefaultModel: "qwen2.5-coder:7b",
		Models: []string{"qwen2.5-coder:7b", "gemma3:12b", "llama3.1:8b", "codellama:13b"},
		Hint:   "No API key — Ollama must be running on the agent host",
	},
}

func Lookup(id string) (ProviderDef, bool) {
	want := strings.ToLower(strings.TrimSpace(id))
	for _, p := range Catalog {
		if p.ID == want {
			return p, true
		}
	}
	return ProviderDef{}, false
}
