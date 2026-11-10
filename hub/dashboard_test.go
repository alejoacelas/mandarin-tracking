package main

import (
	"regexp"
	"testing"
)

// An event handler property that returns false cancels the event. A handler written as
// `(e) => cond && action()` returns false for every other key, which blocked typing in the
// settings fields. Handlers must use a block body.
func TestDashboardHandlersDontCancelEvents(t *testing.T) {
	bad := regexp.MustCompile(`\.on(key\w+|input|paste|beforeinput)\s*=\s*\([^)]*\)\s*=>\s*[^{\s]`)
	if m := bad.FindAll(dashboardHTML, -1); len(m) > 0 {
		t.Errorf("handlers with expression bodies can cancel keypresses: %q", m)
	}
}
