/*
 * Quickstart example for libo11y (C11).
 *
 * Demonstrates one-call setup, tracing, correlated structured logging,
 * metric recording with automatic trace exemplar attachment, wide-event
 * accumulation, and bounded graceful shutdown.
 */

#include <stdio.h>

#include "o11y/o11y.h"

int main(void) {
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC; /* hermetic so the example runs cleanly offline */
    opts.service_name = "checkout";
    opts.service_version = "1.0.0";
    opts.environment = O11Y_ENVIRONMENT_DEVELOPMENT;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    o11y_diagnostic_t diag = {0};
    o11y_err_t err = o11y_setup(&opts, &sdk, &diag);
    if (err != O11Y_OK) {
        fprintf(stderr, "telemetry disabled (%s): %s\n", o11y_err_name(err), diag.message);
        return 1;
    }

    o11y_tracer_t *tracer = o11y_tracer(sdk, "checkout");
    o11y_meter_t *meter = o11y_meter(sdk, "checkout");

    o11y_attr_t start_attrs[] = {
        o11y_kv_str("http.request.method", "POST"),
        o11y_kv_str("http.route", "/checkout"),
    };
    o11y_span_start_options_t span_opts = {
        .kind = O11Y_SPAN_KIND_SERVER,
        .attributes = start_attrs,
        .attributes_len = 2,
    };
    o11y_span_t *span = o11y_tracer_start(tracer, NULL, "POST /checkout", &span_opts);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, span);

    /* Correlated structured log inside the active span. */
    o11y_log_attr_t log_attrs[] = {
        o11y_log_kv_str("order.id", "ord-42"),
        o11y_log_kv_secret("payment.card_cvv"),
    };
    o11y_log_info(sdk, ctx, "order accepted", log_attrs, 2);

    /* Metric with automatic trace exemplar attachment. */
    o11y_instrument_options_t counter_opts = { .unit = "{request}" };
    o11y_counter_i64_t requests = o11y_meter_counter_i64(meter, "checkout.requests", &counter_opts);
    o11y_attr_t metric_attrs[] = { o11y_kv_str(O11Y_ATTR_OUTCOME, O11Y_OUTCOME_SUCCESS) };
    o11y_counter_i64_add(requests, ctx, 1, metric_attrs, 1);

    /* Wide-event canonical request summary. */
    o11y_record_t *rec = o11y_record_create();
    o11y_record_set(rec, o11y_log_kv_str("http.request.method", "POST"));
    o11y_record_set(rec, o11y_log_kv_int("http.response.status_code", 200));
    o11y_record_set(rec, o11y_log_kv_double(O11Y_ATTR_DURATION, 0.012));
    o11y_record_set(rec, o11y_log_kv_str(O11Y_ATTR_OUTCOME, O11Y_OUTCOME_SUCCESS));
    o11y_record_add(rec, "checkout.db_queries", 2);
    o11y_record_emit_event(rec, ctx, sdk, O11Y_EVENT_REQUEST_SUMMARY, NULL, 0);
    o11y_record_destroy(rec);

    o11y_ctx_destroy(ctx);
    o11y_span_end(span);

    o11y_shutdown_report_t report = {0};
    (void)o11y_shutdown(sdk, 5000, &report);
    o11y_destroy(sdk);

    return o11y_shutdown_report_ok(report) ? 0 : 1;
}
