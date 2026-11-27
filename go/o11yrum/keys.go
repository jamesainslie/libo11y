package o11yrum

// Attribute keys the gateway reads or writes. keys_test.go checks every
// spec key against the generated spec tables, so a rename in the registry
// fails the build here instead of silently missing data.
const (
	keyServiceName      = "service.name"
	keySessionID        = "session.id"
	keyEventName        = "event.name"
	keyCountry          = "geo.country.iso_code"
	keyURLFull          = "url.full"
	keyURLQuery         = "url.query"
	keyPlatform         = "o11y.rum.platform"
	keyViewID           = "o11y.rum.view.id"
	keyViewName         = "o11y.rum.view.name"
	keyViewKind         = "o11y.rum.view.kind"
	keyActionType       = "o11y.rum.action.type"
	keyErrorSource      = "o11y.rum.error.source"
	keyErrorFingerprint = "o11y.rum.error.fingerprint"
	keyFrustrationType  = "o11y.rum.frustration.type"
	keyDeviceClass      = "o11y.rum.device.class"
	keyConnEffective    = "o11y.rum.connection.effective"
	keyVitalRating      = "o11y.rum.vital.rating"
	keyBrowserFamily    = "o11y.rum.browser.family"
	keyOSName           = "os.name"
	keyUpdateID         = "o11y.rum.app.update_id"
	keySummarySeq       = "o11y.rum.summary.seq"
	keySummaryTime      = "o11y.rum.summary.time_on_view"
	keySummaryLoAF      = "o11y.rum.summary.long_animation_frames"
	keySummaryErrors    = "o11y.rum.summary.errors."       // + o11y.rum.error.source member
	keySummaryFrust     = "o11y.rum.summary.frustrations." // + o11y.rum.frustration.type member
	keySummaryLCP       = "o11y.rum.summary.lcp.value"
	keySummaryINP       = "o11y.rum.summary.inp.value"
	keySummaryCLS       = "o11y.rum.summary.cls.value"
	keySummaryFCP       = "o11y.rum.summary.fcp.value"
	keySummaryTTFB      = "o11y.rum.summary.ttfb.value"
)

// specKeys lists the full spec keys above for the spec check. The
// service, event and url keys are upstream semantic convention keys that
// the registry may neither define nor classify, so they are left out.
var specKeys = []string{
	keySessionID, keyCountry, keyPlatform, keyViewID, keyViewName, keyViewKind,
	keyActionType, keyErrorSource, keyErrorFingerprint, keyFrustrationType,
	keyDeviceClass, keyConnEffective, keyVitalRating, keyBrowserFamily, keyOSName, keyUpdateID,
	keySummarySeq, keySummaryTime, keySummaryLoAF, keySummaryLCP, keySummaryINP,
	keySummaryCLS, keySummaryFCP, keySummaryTTFB,
	keySummaryErrors + "uncaught", keySummaryFrust + "rage",
}

// Event names the gateway recognises.
const (
	eventViewSummary = "o11y.rum.view.summary"
	eventRUMError    = "o11y.rum.error"
)

// The standard RUM metrics the gateway derives from view summaries.
const (
	metricViews       = "o11y.rum.views"
	metricErrors      = "o11y.rum.errors"
	metricFrustration = "o11y.rum.frustrations"
	metricLoAF        = "o11y.rum.browser.long_animation_frames"
	metricLCP         = "o11y.rum.vital.lcp"
	metricINP         = "o11y.rum.vital.inp"
	metricCLS         = "o11y.rum.vital.cls"
	metricFCP         = "o11y.rum.vital.fcp"
	metricTTFB        = "o11y.rum.vital.ttfb"
)

var standardMetrics = []string{
	metricViews, metricErrors, metricFrustration, metricLoAF,
	metricLCP, metricINP, metricCLS, metricFCP, metricTTFB,
}
