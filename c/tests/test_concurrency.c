#define _POSIX_C_SOURCE 200809L

#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "o11y/test.h"
#include "test_framework.h"

#define CONCURRENCY_THREADS 6
#define CONCURRENCY_ITERS 25

static const char *CONCURRENCY_APP_REGISTRY =
    "schema: libo11y.app-registry/v1\n"
    "namespace: conc\n"
    "attributes:\n"
    "  conc.user.email: {type: string, sensitivity: pii, cardinality: unbounded}\n"
    "  conc.user.secret: {type: string, sensitivity: secret, cardinality: unbounded}\n"
    "  conc.req.iter: {type: int, sensitivity: public, cardinality: bounded}\n";

typedef struct carrier_buf {
    char traceparent[256];
    char tracestate[256];
    char baggage[512];
} carrier_buf_t;

static const char *conc_carrier_get(void *ud, const char *key) {
    const carrier_buf_t *c = (const carrier_buf_t *)ud;
    if (strcmp(key, "traceparent") == 0) return c->traceparent[0] ? c->traceparent : NULL;
    if (strcmp(key, "tracestate") == 0) return c->tracestate[0] ? c->tracestate : NULL;
    if (strcmp(key, "baggage") == 0) return c->baggage[0] ? c->baggage : NULL;
    return NULL;
}

static void conc_carrier_set(void *ud, const char *key, const char *val) {
    carrier_buf_t *c = (carrier_buf_t *)ud;
    if (strcmp(key, "traceparent") == 0) snprintf(c->traceparent, sizeof(c->traceparent), "%s", val);
    else if (strcmp(key, "tracestate") == 0) snprintf(c->tracestate, sizeof(c->tracestate), "%s", val);
    else if (strcmp(key, "baggage") == 0) snprintf(c->baggage, sizeof(c->baggage), "%s", val);
}

static void observe_queue_depth(void *userdata, o11y_observation_i64_t *obs) {
    atomic_int *calls = (atomic_int *)userdata;
    int val = atomic_fetch_add(calls, 1) + 1;
    o11y_attr_t attrs[] = { o11y_kv_str("conc.user.email", "leak@example.com") };
    o11y_observation_i64_observe(obs, val, attrs, 1);
}

typedef struct worker_arg {
    int tid;
    o11y_test_recorder_t *rec;
    o11y_sdk_t *sdk;
    o11y_tracer_t *tracer;
    o11y_counter_i64_t counter;
    o11y_histogram_f64_t hist;
    atomic_int *failures;
} worker_arg_t;

static void *worker_main(void *raw) {
    worker_arg_t *w = (worker_arg_t *)raw;

    for (int i = 0; i < CONCURRENCY_ITERS; i++) {
        o11y_attr_t span_attrs[] = {
            o11y_kv_int("conc.req.iter", i),
            o11y_kv_str("conc.user.email", "worker@example.com"),
        };
        o11y_span_start_options_t sopts = {
            .kind = O11Y_SPAN_KIND_SERVER,
            .attributes = span_attrs,
            .attributes_len = 2,
        };
        o11y_span_t *sp = o11y_tracer_start(w->tracer, NULL, "conc.op", &sopts);
        if (sp == NULL) {
            atomic_fetch_add(w->failures, 1);
            continue;
        }
        o11y_span_add_event(sp, "step", NULL, 0, 0);

        o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, sp);
        o11y_ctx_t *bag_ctx = o11y_ctx_with_baggage_item(ctx, "tenant", "acme");

        /* Propagation inject / extract over thread-local carrier */
        carrier_buf_t cbuf = {0};
        o11y_carrier_t carrier = { .userdata = &cbuf, .get = conc_carrier_get, .set = conc_carrier_set };
        o11y_inject(w->sdk, bag_ctx, &carrier);
        o11y_ctx_t *extracted = o11y_extract(w->sdk, NULL, &carrier);

        /* Structured & nested log with redaction + PII drop */
        o11y_log_attr_t inner[] = {
            o11y_log_kv_str("email", "nested@example.com"),
            o11y_log_kv_secret("token"),
        };
        o11y_log_attr_t user_map[] = {
            o11y_log_kv_map("user", inner, 2),
        };
        o11y_log_attr_t log_attrs[] = {
            o11y_log_kv_map("conc", user_map, 1),
            o11y_log_kv_int("conc.req.iter", i),
        };
        o11y_log_info(w->sdk, bag_ctx, "conc.log", log_attrs, 2);

        /* Sync metrics inside active span context -> exemplars */
        o11y_attr_t mattrs[] = { o11y_kv_int("conc.req.iter", i % 4) };
        o11y_counter_i64_add(w->counter, bag_ctx, 1, mattrs, 1);
        o11y_histogram_f64_record(w->hist, bag_ctx, 12.5, mattrs, 1);

        /* Wide-event record emission */
        o11y_record_t *rec_ev = o11y_record_create();
        o11y_record_set(rec_ev, o11y_log_kv_str("http.request.method", "POST"));
        o11y_record_set(rec_ev, o11y_log_kv_int("http.response.status_code", 200));
        o11y_record_set(rec_ev, o11y_log_kv_double(O11Y_ATTR_DURATION, 0.005));
        o11y_record_set(rec_ev, o11y_log_kv_str(O11Y_ATTR_OUTCOME, O11Y_OUTCOME_SUCCESS));
        o11y_record_add(rec_ev, "conc.req.iter", 1);
        o11y_record_emit_event(rec_ev, extracted, w->sdk, O11Y_EVENT_REQUEST_SUMMARY, NULL, 0);
        o11y_record_destroy(rec_ev);

        /* Concurrent recorder reads (no o11y_test_reset) */
        (void)o11y_test_span_count(w->rec);
        (void)o11y_test_log_count(w->rec);
        size_t clen = 0;
        if (o11y_test_console_output(w->rec, &clen) == NULL) {
            atomic_fetch_add(w->failures, 1);
        }
        (void)o11y_test_has_metric(w->rec, "conc.ops");
        int64_t sum = 0;
        (void)o11y_test_metric_sum_i64(w->rec, "conc.ops", &sum);
        (void)o11y_test_violations(w->rec, NULL, NULL);

        o11y_ctx_destroy(extracted);
        o11y_ctx_destroy(bag_ctx);
        o11y_ctx_destroy(ctx);
        o11y_span_end(sp);
    }
    return NULL;
}

static void test_concurrent_emitters_and_recorder_reads(void) {
    o11y_app_registry_source_t regs[] = {
        { .file_path = "conc.yaml", .content = CONCURRENCY_APP_REGISTRY, .content_len = strlen(CONCURRENCY_APP_REGISTRY) },
    };
    o11y_test_options_t opts = o11y_test_options_default();
    opts.app_registries = regs;
    opts.app_registries_len = 1;
    opts.pii_mode = O11Y_PII_DROP;
    opts.console_enabled = true;
    opts.log_export = true;
    opts.runtime_metrics = false;

    o11y_test_recorder_t *rec = NULL;
    o11y_diagnostic_t diag = {0};
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&opts, &rec, &diag));
    o11y_sdk_t *sdk = o11y_test_sdk(rec);

    o11y_tracer_t *tracer = o11y_tracer(sdk, "conc");
    o11y_meter_t *meter = o11y_meter(sdk, "conc");
    o11y_counter_i64_t counter = o11y_meter_counter_i64(meter, "conc.ops", NULL);
    o11y_histogram_f64_t hist = o11y_meter_histogram_f64(meter, "conc.latency", NULL);

    atomic_int obs_calls = 0;
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_gauge_i64(meter, "conc.queue", NULL, observe_queue_depth, &obs_calls));

    atomic_int failures = 0;
    pthread_t threads[CONCURRENCY_THREADS];
    worker_arg_t args[CONCURRENCY_THREADS];
    for (int i = 0; i < CONCURRENCY_THREADS; i++) {
        args[i] = (worker_arg_t){
            .tid = i,
            .rec = rec,
            .sdk = sdk,
            .tracer = tracer,
            .counter = counter,
            .hist = hist,
            .failures = &failures,
        };
        ASSERT_EQ_INT(0, pthread_create(&threads[i], NULL, worker_main, &args[i]));
    }
    for (int i = 0; i < CONCURRENCY_THREADS; i++) {
        ASSERT_EQ_INT(0, pthread_join(threads[i], NULL));
    }

    ASSERT_EQ_INT(0, atomic_load(&failures));

    const size_t total = CONCURRENCY_THREADS * CONCURRENCY_ITERS;
    ASSERT_EQ_SIZE(total, o11y_test_span_count(rec));
    ASSERT_EQ_SIZE(total * 2, o11y_test_log_count(rec));
    ASSERT_EQ_SIZE(total * 2, o11y_test_otlp_log_count(rec));

    int64_t sum = 0;
    ASSERT_TRUE(o11y_test_metric_sum_i64(rec, "conc.ops", &sum));
    ASSERT_EQ_INT((long long)total, sum);

    uint64_t hcount = 0;
    ASSERT_TRUE(o11y_test_metric_histogram_count(rec, "conc.latency", &hcount));
    ASSERT_EQ_INT((long long)total, (long long)hcount);

    ASSERT_TRUE(o11y_test_has_metric(rec, "conc.queue"));
    ASSERT_TRUE(atomic_load(&obs_calls) >= 1);
    ASSERT_FALSE(o11y_test_metric_has_attr(rec, "conc.queue", "conc.user.email"));

    ASSERT_TRUE(o11y_test_exemplar_count(rec, "conc.ops") >= 1);
    ASSERT_TRUE(o11y_test_violations(rec, O11Y_SIGNAL_TRACES, "pii_attribute") >= (int64_t)total);
    ASSERT_TRUE(o11y_test_violations(rec, O11Y_SIGNAL_LOGS, "pii_attribute") >= (int64_t)total);

    size_t console_len = 0;
    const char *console = o11y_test_console_output(rec, &console_len);
    ASSERT_NOT_NULL(console);
    ASSERT_TRUE(console_len > 0);
    ASSERT_TRUE(strstr(console, "nested@example.com") == NULL);
    ASSERT_TRUE(strstr(console, "raw-secret") == NULL);

    o11y_test_report_t *conf = o11y_test_check_conforms(rec);
    ASSERT_TRUE(o11y_test_report_ok(conf));
    o11y_test_report_destroy(conf);

    o11y_test_report_t *corr = o11y_test_check_correlated(rec);
    ASSERT_TRUE(o11y_test_report_ok(corr));
    o11y_test_report_destroy(corr);

    o11y_test_report_t *tri = o11y_test_check_triangle(rec, "conc.ops");
    ASSERT_TRUE(o11y_test_report_ok(tri));
    o11y_test_report_destroy(tri);

    o11y_test_destroy(rec);
}

static void obs_race_cb(void *userdata, o11y_observation_i64_t *obs) {
    atomic_int *calls = (atomic_int *)userdata;
    int v = atomic_fetch_add(calls, 1) + 1;
    o11y_observation_i64_observe(obs, v, NULL, 0);
}

typedef struct obs_race_arg {
    o11y_meter_t *meter;
    atomic_int *go;
    atomic_int *stop;
    atomic_int *calls;
    atomic_int *bad_err;
} obs_race_arg_t;

static void *obs_register_worker(void *raw) {
    obs_race_arg_t *arg = (obs_race_arg_t *)raw;
    while (atomic_load_explicit(arg->go, memory_order_acquire) == 0) {
    }
    for (int i = 0; i < 64 && atomic_load_explicit(arg->stop, memory_order_relaxed) == 0; i++) {
        o11y_err_t e1 = o11y_meter_observable_gauge_i64(arg->meter, "race.gauge", NULL, obs_race_cb, arg->calls);
        if (e1 != O11Y_OK && e1 != O11Y_ERR_SHUTDOWN && e1 != O11Y_ERR_OUT_OF_MEMORY) {
            atomic_fetch_add(arg->bad_err, 1);
        }
        o11y_err_t e2 = o11y_meter_observable_counter_i64(arg->meter, "race.counter", NULL, obs_race_cb, arg->calls);
        if (e2 != O11Y_OK && e2 != O11Y_ERR_SHUTDOWN && e2 != O11Y_ERR_OUT_OF_MEMORY) {
            atomic_fetch_add(arg->bad_err, 1);
        }
        o11y_err_t e3 = o11y_meter_observable_updown_i64(arg->meter, "race.updown", NULL, obs_race_cb, arg->calls);
        if (e3 != O11Y_OK && e3 != O11Y_ERR_SHUTDOWN && e3 != O11Y_ERR_OUT_OF_MEMORY) {
            atomic_fetch_add(arg->bad_err, 1);
        }
    }
    return NULL;
}

static void test_concurrent_observable_register_and_shutdown(void) {
    for (int iter = 0; iter < 20; iter++) {
        o11y_options_t opts = o11y_options_default();
        opts.env_mode = O11Y_ENV_HERMETIC;
        opts.service_name = "obs-race";
        opts.environment = O11Y_ENVIRONMENT_TEST;
        opts.console_enabled = false;
        opts.runtime_metrics = false;

        o11y_sdk_t *sdk = NULL;
        ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
        o11y_meter_t *meter = o11y_meter(sdk, "obs-race");

        atomic_int go = 0;
        atomic_int stop = 0;
        atomic_int calls = 0;
        atomic_int bad_err = 0;
        obs_race_arg_t args[3];
        pthread_t th[3];
        for (int t = 0; t < 3; t++) {
            args[t] = (obs_race_arg_t){
                .meter = meter,
                .go = &go,
                .stop = &stop,
                .calls = &calls,
                .bad_err = &bad_err,
            };
            ASSERT_EQ_INT(0, pthread_create(&th[t], NULL, obs_register_worker, &args[t]));
        }

        atomic_store_explicit(&go, 1, memory_order_release);
        (void)o11y_force_flush(sdk, 1, NULL);
        o11y_err_t s_err = o11y_shutdown(sdk, (iter % 2 == 0) ? 500 : 1, NULL);
        ASSERT_TRUE(s_err == O11Y_OK || s_err == O11Y_ERR_TIMEOUT);
        atomic_store_explicit(&stop, 1, memory_order_relaxed);

        for (int t = 0; t < 3; t++) {
            ASSERT_EQ_INT(0, pthread_join(th[t], NULL));
        }
        ASSERT_EQ_INT(0, atomic_load(&bad_err));

        /* Post-shutdown force_flush / repeat shutdown + destroy must stay safe. */
        (void)o11y_force_flush(sdk, 100, NULL);
        o11y_destroy(sdk);
    }

    for (int iter = 0; iter < 5; iter++) {
        o11y_test_recorder_t *rec = NULL;
        ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(NULL, &rec, NULL));
        o11y_sdk_t *sdk = o11y_test_sdk(rec);
        o11y_meter_t *meter = o11y_meter(sdk, "obs-rec-race");

        atomic_int go = 0;
        atomic_int stop = 0;
        atomic_int calls = 0;
        atomic_int bad_err = 0;
        obs_race_arg_t args[2];
        pthread_t th[2];
        for (int t = 0; t < 2; t++) {
            args[t] = (obs_race_arg_t){
                .meter = meter,
                .go = &go,
                .stop = &stop,
                .calls = &calls,
                .bad_err = &bad_err,
            };
            ASSERT_EQ_INT(0, pthread_create(&th[t], NULL, obs_register_worker, &args[t]));
        }

        atomic_store_explicit(&go, 1, memory_order_release);
        ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(sdk, 500, NULL));
        atomic_store_explicit(&stop, 1, memory_order_relaxed);
        for (int t = 0; t < 2; t++) {
            ASSERT_EQ_INT(0, pthread_join(th[t], NULL));
        }
        ASSERT_EQ_INT(0, atomic_load(&bad_err));
        o11y_test_destroy(rec);
    }

    /* Direct o11y_test_destroy without prior explicit o11y_shutdown runs final
     * observable collection cleanly and frees trampolines without leaks. */
    o11y_test_recorder_t *direct_rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(NULL, &direct_rec, NULL));
    atomic_int direct_calls = 0;
    o11y_meter_t *dm = o11y_meter(o11y_test_sdk(direct_rec), "obs-direct");
    ASSERT_EQ_ERR(O11Y_OK, o11y_meter_observable_gauge_i64(dm, "direct.gauge", NULL, obs_race_cb, &direct_calls));
    ASSERT_TRUE(o11y_test_has_metric(direct_rec, "direct.gauge"));
    ASSERT_TRUE(atomic_load(&direct_calls) >= 1);
    o11y_test_destroy(direct_rec);
}

int main(void) {
    RUN_TEST(test_concurrent_emitters_and_recorder_reads);
    RUN_TEST(test_concurrent_observable_register_and_shutdown);
    TEST_SUMMARY("test_concurrency");
}
