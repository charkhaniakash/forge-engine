package execution

import (
	"fmt"
	"strings"
)

// DiffResult holds a unified diff and its statistics.
// Go computes this — the agent sends only the new file content.
type DiffResult struct {
	Unified      string
	LinesAdded   int
	LinesRemoved int
}

// ComputeUnifiedDiff generates a unified diff between old and new content.
// Uses a simple line-by-line comparison. Phase 8+ can upgrade to a proper
// Myers diff library without changing the interface.
func ComputeUnifiedDiff(filePath, oldContent, newContent string) DiffResult {
	oldLines := splitLines(oldContent)
	newLines := splitLines(newContent)

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("--- a/%s\n", filePath))
	sb.WriteString(fmt.Sprintf("+++ b/%s\n", filePath))

	added, removed := 0, 0

	// Simple LCS-based hunk generation.
	hunks := computeHunks(oldLines, newLines)
	for _, hunk := range hunks {
		sb.WriteString(hunk.header)
		for _, line := range hunk.lines {
			sb.WriteString(line)
			if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
				added++
			} else if strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---") {
				removed++
			}
		}
	}

	return DiffResult{
		Unified:      sb.String(),
		LinesAdded:   added,
		LinesRemoved: removed,
	}
}

type hunk struct {
	header string
	lines  []string
}

func splitLines(s string) []string {
	if s == "" {
		return []string{}
	}
	lines := strings.Split(s, "\n")
	// Remove the empty string that Split produces after a trailing newline.
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// computeHunks produces unified diff hunks using a simple edit-script approach.
// Context lines (3) are added around each changed region.
func computeHunks(old, new []string) []hunk {
	const context = 3

	type edit struct {
		oldIdx int // -1 = insertion
		newIdx int // -1 = deletion
	}

	// Build edit script: linear scan comparing lines.
	// For production use replace with a proper LCS algorithm.
	edits := lcsEdits(old, new)

	if len(edits) == 0 {
		return nil
	}

	var hunks []hunk
	i := 0
	for i < len(edits) {
		// Find the next change.
		for i < len(edits) && edits[i].oldIdx >= 0 && edits[i].newIdx >= 0 {
			i++
		}
		if i >= len(edits) {
			break
		}

		// Determine hunk start/end with context.
		start := i
		end := i
		for end < len(edits) && !(end > i && edits[end-1].oldIdx >= 0 && edits[end-1].newIdx >= 0 &&
			end+1 < len(edits) && edits[end+1].oldIdx >= 0 && edits[end+1].newIdx >= 0) {
			end++
		}

		// Apply context window.
		ctxStart := start - context
		if ctxStart < 0 {
			ctxStart = 0
		}
		ctxEnd := end + context
		if ctxEnd > len(edits) {
			ctxEnd = len(edits)
		}

		oldStart, newStart := 1, 1
		oldCount, newCount := 0, 0
		var lines []string

		for _, e := range edits[ctxStart:ctxEnd] {
			switch {
			case e.oldIdx >= 0 && e.newIdx >= 0:
				lines = append(lines, " "+old[e.oldIdx]+"\n")
				oldCount++
				newCount++
			case e.oldIdx >= 0:
				lines = append(lines, "-"+old[e.oldIdx]+"\n")
				oldCount++
			case e.newIdx >= 0:
				lines = append(lines, "+"+new[e.newIdx]+"\n")
				newCount++
			}
		}

		if ctxStart > 0 {
			// Approximate oldStart/newStart.
			for _, e := range edits[:ctxStart] {
				if e.oldIdx >= 0 {
					oldStart++
				}
				if e.newIdx >= 0 {
					newStart++
				}
			}
		}

		header := fmt.Sprintf("@@ -%d,%d +%d,%d @@\n", oldStart, oldCount, newStart, newCount)
		hunks = append(hunks, hunk{header: header, lines: lines})
		i = ctxEnd
	}

	return hunks
}

type editEntry struct {
	oldIdx int
	newIdx int
}

// lcsEdits produces a simple edit script using patience diff (simplified).
// This is intentionally simple for Phase 7. Phase 8 can upgrade without
// changing any caller.
func lcsEdits(old, new []string) []editEntry {
	var edits []editEntry
	oi, ni := 0, 0
	for oi < len(old) && ni < len(new) {
		if old[oi] == new[ni] {
			edits = append(edits, editEntry{oi, ni})
			oi++
			ni++
		} else {
			// Naive: emit deletion then insertion.
			edits = append(edits, editEntry{oi, -1})
			oi++
			edits = append(edits, editEntry{-1, ni})
			ni++
		}
	}
	for ; oi < len(old); oi++ {
		edits = append(edits, editEntry{oi, -1})
	}
	for ; ni < len(new); ni++ {
		edits = append(edits, editEntry{-1, ni})
	}
	return edits
}
