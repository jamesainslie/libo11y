#include "o11y/test.h"
#include "test_framework.h"

static void observe_queue_depth(void *userdata, o11y_observation_f64_t *obs) {
    double *depth = (double *)userdata;
    o11y_attr_t attrs[] = { o11y_kv_str("queue.name", "emails") };
    o11y_observation_f64_observe(obs, *depth, attrs, 1);
}

static void observe_jobs_total(void *userdata, o11y_observation_i64_t *obs) {
    int64_t *count = (int64_t *)userdata;
    o11y_observation_i64_observe(obs, *count, NULL, 0);
}

static void test_sync_and_observable_instruments(void) {
    double buckets[] = { 0.01, 0.05, 0.1, 0.5, 1.0 };
    o11y_histogram_buckets_t hb[] = {
        { .instrument_name = "http.server.request.duration", .boundaries = buckets, .boundaries_len = 5 },
    };

    o11y_test_options_t topts = o11y_test_options_default();
    topts.histogram_buckets = hb;
    topts.histogram_buckets_len = 1;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));

    o11y_sdk_t *sdk = o11y_test_sdk(rec);
    o11y_meter_t *meter = o11y_meter(sdk, "checkout");

    o11y_counter_i64_t c_i64 = o11y_meter_counter_i64(meter, "orders.count", NULL);
    o11y_counter_f64_t c_f64 = o11y_meter_counter_f64(meter, "orders.revenue", NULL);
    o11y_updown_i64_t ud = o11y_meter_updown_i64(meter, "orders.inflight", NULL);
    o11y_gauge_f64_t g = o11y_meter_gauge_f64(meter, "cpu.temp", NULL);
    o11y_histogram_options_t hopts = { .unit = "s" };
    o11y_histogram_f64_t h = o11y_meter_histogram_f64(meter, "http.server.request.duration", &hopts);

    o11y_attr_t attrs[] = { o11y_kv_str("region", "us-west") };
    o11y_counter_i64_add(c_i64, NULL, 3, attrs, 1);
    o11y_counter_i64_add(c_i64, NULL, 4, attrs, 1);
    o11y_counter_f64_add(c_f64, NULL, 19.5, attrs, 1);
    o11y_updown_i64_add(ud, NULL, 5, NULL, 0);
    o11y_updown_i64_add(ud, NULL, -2, NULL, 0);
    o11y_gauge_f64_record(g, NULL, 61.25, NULL, 0);
    o11y_histogram_f64_record(h, NULL, 0.042, attrs, 1);
    o11y_histogram_f64_record(h, NULL, 0.250, attrs, 1);

    double q_depth = 17.5;
    int64_t jobs = 99;
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_gauge_f64(meter, "queue.depth", NULL, observe_queue_depth, &q_depth));
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_counter_i64(meter, "jobs.completed", NULL, observe_jobs_total, &jobs));

    int64_t sum_i = 0;
    double sum_f = 0.0;
    uint64_t hcount = 0;

    ASSERT_TRUE(o11y_test_metric_sum_i64(rec, "orders.count", &sum_i));
    ASSERT_EQ_INT(7, sum_i);

    ASSERT_TRUE(o11y_test_metric_sum_f64(rec, "orders.revenue", &sum_f));
    ASSERT_EQ_DBL(19.5, sum_f, 1e-6);

    ASSERT_TRUE(o11y_test_metric_sum_i64(rec, "orders.inflight", &sum_i));
    ASSERT_EQ_INT(3, sum_i);

    ASSERT_TRUE(o11y_test_metric_sum_f64(rec, "cpu.temp", &sum_f));
    ASSERT_EQ_DBL(61.25, sum_f, 1e-6);

    ASSERT_TRUE(o11y_test_metric_histogram_count(rec, "http.server.request.duration", &hcount));
    ASSERT_EQ_INT(2, (int64_t)hcount);

    ASSERT_TRUE(o11y_test_metric_sum_f64(rec, "queue.depth", &sum_f));
    ASSERT_EQ_DBL(17.5, sum_f, 1e-6);

    ASSERT_TRUE(o11y_test_metric_sum_i64(rec, "jobs.completed", &sum_i));
    ASSERT_EQ_INT(99, sum_i);

    o11y_test_destroy(rec);
}

static void observe_i64(void *userdata, o11y_observation_i64_t *obs) {
    o11y_observation_i64_observe(obs, *(const int64_t *)userdata, NULL, 0);
}

static void observe_f64(void *userdata, o11y_observation_f64_t *obs) {
    o11y_observation_f64_observe(obs, *(const double *)userdata, NULL, 0);
}

/* Every observable kind exists for both number types. */
static void test_every_observable_instrument(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    o11y_meter_t *meter = o11y_meter(o11y_test_sdk(rec), "pool");

    int64_t i_val = 7;
    double f_val = 2.5;
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_counter_i64(meter, "pool.acquired", NULL, observe_i64, &i_val));
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_counter_f64(meter, "pool.wait.time", NULL, observe_f64, &f_val));
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_updown_i64(meter, "pool.idle", NULL, observe_i64, &i_val));
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_updown_f64(meter, "pool.load", NULL, observe_f64, &f_val));
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_gauge_i64(meter, "pool.size", NULL, observe_i64, &i_val));
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_gauge_f64(meter, "pool.utilization", NULL, observe_f64, &f_val));

    static const char *const int_names[] = { "pool.acquired", "pool.idle", "pool.size" };
    static const char *const float_names[] = { "pool.wait.time", "pool.load", "pool.utilization" };
    for (size_t i = 0; i < 3; i++) {
        int64_t got_i = 0;
        double got_f = 0.0;
        ASSERT_TRUE(o11y_test_metric_sum_i64(rec, int_names[i], &got_i));
        ASSERT_EQ_INT(7, got_i);
        ASSERT_TRUE(o11y_test_metric_sum_f64(rec, float_names[i], &got_f));
        ASSERT_EQ_DBL(2.5, got_f, 1e-9);
    }

    /* A NULL meter or callback is refused, and a NULL SDK's meter is a no-op. */
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_meter_observable_gauge_i64(NULL, "x", NULL, observe_i64, &i_val));
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_meter_observable_gauge_i64(meter, "x", NULL, NULL, &i_val));
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_gauge_i64(o11y_meter(NULL, "noop"), "x", NULL, observe_i64, &i_val));

    o11y_test_destroy(rec);
}

static void test_exemplars_and_three_way_triangle(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));

    o11y_sdk_t *sdk = o11y_test_sdk(rec);
    o11y_tracer_t *tr = o11y_tracer(sdk, "api");
    o11y_meter_t *meter = o11y_meter(sdk, "api");
    o11y_histogram_f64_t dur = o11y_meter_histogram_f64(meter, "http.server.request.duration", NULL);

    o11y_span_t *sp = o11y_tracer_start(tr, NULL, "GET /items", NULL);
    o11y_span_context_t sc = o11y_span_context(sp);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, sp);

    o11y_log_info(sdk, ctx, "served items", NULL, 0);
    o11y_histogram_f64_record(dur, ctx, 0.123, NULL, 0);

    o11y_ctx_destroy(ctx);
    o11y_span_end(sp);

    ASSERT_TRUE(o11y_test_exemplar_count(rec, "http.server.request.duration") >= 1);
    o11y_test_exemplar_t ex = {0};
    ASSERT_TRUE(o11y_test_exemplar_at(rec, "http.server.request.duration", 0, &ex));
    ASSERT_TRUE(memcmp(sc.trace_id.bytes, ex.trace_id.bytes, 16) == 0);
    ASSERT_TRUE(memcmp(sc.span_id.bytes, ex.span_id.bytes, 8) == 0);
    ASSERT_EQ_DBL(0.123, ex.value, 1e-6);

    o11y_test_report_t *tri = o11y_test_check_triangle(rec, "http.server.request.duration");
    ASSERT_NOT_NULL(tri);
    ASSERT_TRUE(o11y_test_report_ok(tri));
    o11y_test_report_destroy(tri);

    o11y_test_report_t *corr = o11y_test_check_correlated(rec);
    ASSERT_NOT_NULL(corr);
    ASSERT_TRUE(o11y_test_report_ok(corr));
    o11y_test_report_destroy(corr);

    o11y_test_report_t *conf = o11y_test_check_conforms(rec);
    ASSERT_NOT_NULL(conf);
    ASSERT_TRUE(o11y_test_report_ok(conf));
    o11y_test_report_destroy(conf);

    o11y_test_destroy(rec);
}

static void test_exemplar_filter_always_off(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    topts.exemplar_filter = O11Y_EXEMPLAR_FILTER_ALWAYS_OFF;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));

    o11y_sdk_t *sdk = o11y_test_sdk(rec);
    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "api"), NULL, "op", NULL);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, sp);
    o11y_counter_i64_t c = o11y_meter_counter_i64(o11y_meter(sdk, "api"), "ops", NULL);
    o11y_counter_i64_add(c, ctx, 1, NULL, 0);
    o11y_ctx_destroy(ctx);
    o11y_span_end(sp);

    ASSERT_EQ_SIZE(0, o11y_test_exemplar_count(rec, "ops"));
    o11y_test_destroy(rec);
}

int main(void) {
    RUN_TEST(test_sync_and_observable_instruments);
    RUN_TEST(test_every_observable_instrument);
    RUN_TEST(test_exemplars_and_three_way_triangle);
    RUN_TEST(test_exemplar_filter_always_off);
    TEST_SUMMARY("test_metrics");
}
