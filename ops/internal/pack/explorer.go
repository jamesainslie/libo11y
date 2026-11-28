package pack

import "github.com/jamesainslie/libo11y/ops/internal/dash"

const explorerHelp = `**How to use.** Paste a ` + "`session.id`" + ` into the session.id box, or open a session from the errors and frustration dashboard. Then pick a view from "Views in this session" to fill o11y.rum.view.id. Every RUM span and event carries ` + "`session.id`" + `, and views and their events carry ` + "`o11y.rum.view.id`" + ` (RUM.md). Loki keeps both as structured metadata, never as stream labels, and Tempo keeps them as span attributes.`

// selectedView is the caveat of the panels that need a view.
const selectedView = " Empty until view_id (o11y.rum.view.id) is set."

// explorer rebuilds one session from its Loki events and Tempo traces by
// session.id, and one of its views by o11y.rum.view.id. Both IDs are
// structured metadata in Loki, read only after the stream selector.
func explorer() dash.Dashboard {
	// A LogQL label filter treats a missing field as "", so each ID is
	// guarded with != "" and an empty text box matches nothing.
	session := lokiApp + ` | session_id!="" | session_id="$session_id"`
	return dash.Dashboard{
		UID:         "libo11y-rum-session-explorer",
		Title:       "libo11y RUM: session explorer",
		Description: "One RUM session's views, events, traces and spans, by session.id and o11y.rum.view.id.",
		Tags:        []string{"rum"},
		TimeFrom:    "now-24h",
		Variables:   []dash.Variable{varLoki, varTempo, varLokiApp, varSession, varViewID},
		Links: []dash.Link{
			{Title: "Errors and frustration", URL: "/d/libo11y-rum-errors?${app:queryparam}&${__url_time_range}"},
		},
		Rows: [][]dash.Panel{
			{{Type: "text", Title: "How to use", W: 24, H: 3, Content: explorerHelp}},
			{
				{
					Type: "table", Title: "Views in this session", W: 12, Datasource: &dash.Loki,
					Description: "The session's views, from their view summaries. Open a row to show that view below.",
					Targets: []dash.Target{dash.LokiInstant("A",
						`sum by (o11y_rum_view_id, o11y_rum_view_name, o11y_rum_view_kind) (count_over_time(`+session+` | event_name="o11y.rum.view.summary" [$__range]))`)},
					Overrides: []any{rename("Value #A", "summaries")}, Transforms: []any{hideTime()},
					Links: []dash.Link{{
						Title: "Select this view",
						URL:   "/d/libo11y-rum-session-explorer?${session_id:queryparam}&var-view_id=${__data.fields.o11y_rum_view_id:percentencode}&${app:queryparam}&${__url_time_range}",
					}},
				},
				{
					Type: "table", Title: "Traces in this session", W: 12, Datasource: &dash.Tempo,
					Description: "The session's traces. A fetch span's backend children share its trace, so backend spans come with it.",
					Targets:     []dash.Target{dash.TempoSearch("A", `{ span.session.id = "$session_id" }`, "traces", 100)},
				},
			},
			{{
				Type: "logs", Title: "Session timeline", W: 24, H: 12, Datasource: &dash.Loki,
				Description: "Every event of the session, oldest first.",
				Targets:     []dash.Target{dash.LokiLogs("A", session)},
				Options:     logOptions("Ascending"),
			}},
			{
				{
					Type: "table", Title: "Spans of the selected view", W: 12, H: 10, Datasource: &dash.Tempo,
					Description: "The spans of the selected view." + selectedView,
					Targets:     []dash.Target{dash.TempoSearch("A", `{ span.session.id = "$session_id" && span.o11y.rum.view.id = "$view_id" }`, "spans", 200)},
				},
				{
					Type: "logs", Title: "Events of the selected view", W: 12, H: 10, Datasource: &dash.Loki,
					Description: "The events of the selected view, oldest first." + selectedView,
					Targets:     []dash.Target{dash.LokiLogs("A", session+` | o11y_rum_view_id!="" | o11y_rum_view_id="$view_id"`)},
					Options:     logOptions("Ascending"),
				},
			},
			{{
				Type: "logs", Title: "Errors and frustration in this session", W: 24, Datasource: &dash.Loki,
				Description: "The session's error and frustration events, oldest first.",
				Targets:     []dash.Target{dash.LokiLogs("A", session+` | event_name=~"o11y\\.rum\\.(error|frustration)"`)},
				Options:     logOptions("Ascending"),
			}},
		},
	}
}
