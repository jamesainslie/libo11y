package o11ygin_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ygin"
)

func TestNilArgumentsDoNotPanic(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for name, opts := range map[string][]o11ygin.Option{
		"nil option":                {nil},
		"WithSDK nil":               {o11ygin.WithSDK(nil)},
		"WithSDK zero":              {o11ygin.WithSDK(&o11y.SDK{})},
		"WithFilter nil":            {o11ygin.WithFilter(nil)},
		"WithIgnorePaths none":      {o11ygin.WithIgnorePaths()},
		"WithSpanNameFormatter nil": {o11ygin.WithSpanNameFormatter(nil)},
		"WithServerTiming no SDK":   {o11ygin.WithServerTiming()},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("panicked: %v", r)
				}
			}()
			router := gin.New()
			router.Use(o11ygin.Middleware("api", opts...))
			router.GET("/x", func(c *gin.Context) { c.Status(http.StatusTeapot) })
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
			if w.Code != http.StatusTeapot {
				t.Errorf("status = %d, want %d", w.Code, http.StatusTeapot)
			}
		})
	}
}
