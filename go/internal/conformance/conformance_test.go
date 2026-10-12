package conformance

import "testing"

func TestCheckEvent(t *testing.T) {
	cases := []struct {
		name     string
		event    string
		keys     []string
		problems int
	}{
		{"template satisfied", "o11y.telemetry.configured", []string{"o11y.config.traces"}, 0},
		{"template missing", "o11y.telemetry.configured", []string{"traces", "o11y.config"}, 1},
		{"template empty suffix", "o11y.telemetry.configured", []string{"o11y.config."}, 1},
		{"summary complete", "o11y.request.summary", []string{"http.request.method", "http.response.status_code", "o11y.outcome", "o11y.duration"}, 0},
		{"summary missing three", "o11y.request.summary", []string{"http.request.method"}, 3},
		{"unregistered", "app.custom", nil, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CheckEvent(tc.event, tc.keys); len(got) != tc.problems {
				t.Errorf("CheckEvent = %v, want %d problems", got, tc.problems)
			}
		})
	}
}
