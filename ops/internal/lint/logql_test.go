package lint

import (
	"fmt"
	"strings"
	"testing"
)

func TestCheckLogQL(t *testing.T) {
	ok := []string{
		`{service_name=~".+"} | session_id="x" | event_name="o11y.rum.error"`,
		`topk(10, sum by (session_id) (count_over_time({service_name=~".+"} | event_name="o11y.rum.error" [1h])))`,
		`{service_name="shop-web"} |= "TypeError" | session_id="s" and o11y_rum_view_id=~"v.*"`,
		`sum by (service_name, exception_type) (count_over_time({service_name=~"a|b"} | event_name="o11y.rum.error" | line_format "{{.exception_type}}" [5m]))`,
	}
	for _, q := range ok {
		if errs := CheckLogQL(q); len(errs) > 0 {
			t.Errorf("%s: %v", q, errs)
		}
	}
	bad := map[string]string{
		`{session_id="x"}`:                                              "session_id",
		`{service_name="a", o11y_rum_view_id="v"}`:                      "o11y_rum_view_id",
		`{service_name="a"} | user_email="x"`:                           "user_email",
		`{service_name="a"} or {service_name="b"}`:                      "selector",
		`sum by (user_email) (count_over_time({service_name="a"}[5m]))`: "user_email",
		`{service_name="a"} | session_id="x" and user_id="y"`:           "user_id",
		`count_over_time(| session_id="x" [5m])`:                        "selector",
	}
	for q, want := range bad {
		errs := CheckLogQL(q)
		if len(errs) == 0 || !strings.Contains(fmt.Sprint(errs), want) {
			t.Errorf("%s: %v, want an error mentioning %q", q, errs, want)
		}
	}
}
