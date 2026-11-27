#define _POSIX_C_SOURCE 200809L

#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <unistd.h>

#include "o11y/test.h"
#include "test_framework.h"

static void test_version_and_error_names(void) {
    ASSERT_EQ_STR("0.1.0", o11y_version());
    ASSERT_EQ_STR("O11Y_OK", o11y_err_name(O11Y_OK));
    ASSERT_EQ_STR("O11Y_ERR_ALREADY_SETUP", o11y_err_name(O11Y_ERR_ALREADY_SETUP));
    ASSERT_EQ_STR("O11Y_ERR_NO_SERVICE_NAME", o11y_err_name(O11Y_ERR_NO_SERVICE_NAME));
    ASSERT_EQ_STR("O11Y_ERR_CANARY_REJECTED", o11y_err_name(O11Y_ERR_CANARY_REJECTED));
}

static void test_setup_typed_errors_and_diagnostics(void) {
    o11y_sdk_t *sdk = NULL;
    o11y_diagnostic_t diag = {0};

    /* Missing service_name */
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.environment = O11Y_ENVIRONMENT_TEST;
    ASSERT_EQ_ERR(O11Y_ERR_NO_SERVICE_NAME, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);
    ASSERT_TRUE(diag.len > 0);

    /* Missing environment */
    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "checkout";
    ASSERT_EQ_ERR(O11Y_ERR_NO_ENVIRONMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);
    ASSERT_TRUE(diag.len > 0);

    /* Invalid environment */
    opts.environment = "mars";
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ENVIRONMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);
    ASSERT_STR_CONTAINS(diag.message, "mars");

    /* Custom extra_environments accepted */
    const char *extras[] = { "qa", "mars" };
    opts.extra_environments = extras;
    opts.extra_environments_len = 2;
    opts.console_enabled = false;
    opts.runtime_metrics = false;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, &diag));
    ASSERT_NOT_NULL(sdk);
    o11y_destroy(sdk);
    sdk = NULL;

    /* PIIHash with short key rejected */
    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.pii_mode = O11Y_PII_HASH;
    const uint8_t short_key[16] = {0};
    opts.pii_hash_key = short_key;
    opts.pii_hash_key_len = sizeof(short_key);
    ASSERT_EQ_ERR(O11Y_ERR_PII_HASH_KEY, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);

    /* Unsupported protocol via env rejected */
    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    o11y_env_pair_t env_pairs[] = {
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "thrift" },
    };
    opts.env_pairs = env_pairs;
    opts.env_pairs_len = 1;
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;
    ASSERT_EQ_ERR(O11Y_ERR_UNSUPPORTED_PROTOCOL, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);

    /* Null out_sdk rejected safely */
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, NULL, &diag));
}

static void test_double_setup_guard_and_idempotent_shutdown(void) {
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "billing";
    opts.environment = O11Y_ENVIRONMENT_PRODUCTION;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk1 = NULL;
    o11y_sdk_t *sdk2 = NULL;
    o11y_diagnostic_t diag = {0};
    ASSERT_EQ_ERR(O11Y_OK, o11y_setup(&opts, &sdk1, &diag));
    ASSERT_NOT_NULL(sdk1);

    /* Second setup must fail with ALREADY_SETUP */
    ASSERT_EQ_ERR(O11Y_ERR_ALREADY_SETUP, o11y_setup(&opts, &sdk2, &diag));
    ASSERT_NULL(sdk2);

    /* Effective config summary populated */
    const char *cfg = o11y_effective_config(sdk1);
    ASSERT_NOT_NULL(cfg);
    ASSERT_STR_CONTAINS(cfg, "service.name=billing");
    ASSERT_STR_CONTAINS(cfg, "o11y.config.traces=none");

    /* Idempotent shutdown releases the global guard */
    o11y_shutdown_report_t r1 = {0}, r2 = {0};
    ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(sdk1, 2000, &r1));
    ASSERT_TRUE(o11y_shutdown_report_ok(r1));
    ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(sdk1, 2000, &r2));
    ASSERT_TRUE(o11y_shutdown_report_ok(r2));
    o11y_destroy(sdk1);

    /* After shutdown, setup succeeds again */
    ASSERT_EQ_ERR(O11Y_OK, o11y_setup(&opts, &sdk2, &diag));
    ASSERT_NOT_NULL(sdk2);
    o11y_destroy(sdk2);
}

static void test_env_precedence_and_sdk_resource_metadata(void) {
    /* Verify C SDK stamps telemetry.sdk.language = "c" and spec schema URL */
    o11y_test_options_t topts = o11y_test_options_default();
    topts.service_name = "orders-c";
    topts.service_version = "2.3.4";
    topts.environment = O11Y_ENVIRONMENT_STAGING;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));

    o11y_sdk_t *sdk = o11y_test_sdk(rec);
    o11y_tracer_t *tr = o11y_tracer(sdk, "orders");
    o11y_span_t *sp = o11y_tracer_start(tr, NULL, "GET /orders", NULL);
    o11y_span_end(sp);

    const o11y_test_span_t *recorded = o11y_test_find_span(rec, "GET /orders");
    ASSERT_NOT_NULL(recorded);
    ASSERT_EQ_STR(O11Y_SCHEMA_URL, o11y_test_span_resource_schema_url(recorded));
    ASSERT_EQ_STR("orders-c", o11y_test_span_resource_attr_str(recorded, "service.name"));
    ASSERT_EQ_STR("2.3.4", o11y_test_span_resource_attr_str(recorded, "service.version"));
    ASSERT_EQ_STR("staging", o11y_test_span_resource_attr_str(recorded, O11Y_ENVIRONMENT_KEY));
    ASSERT_EQ_STR("libo11y", o11y_test_span_resource_attr_str(recorded, "telemetry.sdk.name"));
    ASSERT_EQ_STR("c", o11y_test_span_resource_attr_str(recorded, "telemetry.sdk.language"));
    ASSERT_EQ_STR("0.1.0", o11y_test_span_resource_attr_str(recorded, "telemetry.sdk.version"));
    ASSERT_NOT_NULL(o11y_test_span_resource_attr_str(recorded, "service.instance.id"));

    o11y_test_destroy(rec);

    /* Env pairs resolution with OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES */
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    o11y_env_pair_t env_pairs[] = {
        { "OTEL_SERVICE_NAME", "from-env" },
        { "OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=staging" },
        { "OTEL_TRACES_EXPORTER", "none" },
        { "OTEL_METRICS_EXPORTER", "none" },
        { "OTEL_LOGS_EXPORTER", "none" },
    };
    opts.env_pairs = env_pairs;
    opts.env_pairs_len = 5;
    opts.console_enabled = false;
    opts.runtime_metrics = false;
    o11y_sdk_t *sdk_env = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk_env, NULL));
    ASSERT_STR_CONTAINS(o11y_effective_config(sdk_env), "service.name=from-env");
    ASSERT_STR_CONTAINS(o11y_effective_config(sdk_env), "o11y.config.traces=none");
    o11y_destroy(sdk_env);
}

static void test_non_strict_identity_migration_mode(void) {
    o11y_test_options_t topts = o11y_test_options_default();
    topts.service_name = NULL;
    topts.environment = NULL;
    topts.strict_identity = false;
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(&topts, &rec, NULL));
    ASSERT_TRUE(o11y_test_violations(rec, O11Y_SIGNAL_RESOURCE, "identity_service_name") >= 1);
    ASSERT_TRUE(o11y_test_violations(rec, O11Y_SIGNAL_RESOURCE, "identity_environment") >= 1);
    o11y_test_destroy(rec);
}

static void test_null_safety_never_crashes(void) {
    o11y_destroy(NULL);
    o11y_ctx_destroy(NULL);
    o11y_span_end(NULL);
    o11y_record_destroy(NULL);
    o11y_detached_destroy(NULL);
    o11y_linked_span_end(NULL);
    o11y_string_free(NULL);
    o11y_test_destroy(NULL);
    o11y_test_report_destroy(NULL);
    o11y_test_http_receiver_destroy(NULL);
    o11y_test_grpc_receiver_destroy(NULL);

    ASSERT_EQ_STR("", o11y_effective_config(NULL));
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown(NULL, 100, NULL));
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_force_flush(NULL, 100, NULL));
    o11y_log_info(NULL, NULL, "ignored", NULL, 0);
    o11y_event(NULL, NULL, "ignored", NULL, 0);
}

struct sig_test_arg {
    o11y_sdk_t *sdk;
    atomic_int before_called;
    o11y_err_t rc;
};

static void on_before_shutdown(void *userdata) {
    struct sig_test_arg *arg = (struct sig_test_arg *)userdata;
    atomic_store(&arg->before_called, 1);
}

static void *signal_waiter_thread(void *p) {
    struct sig_test_arg *arg = (struct sig_test_arg *)p;
    int sigs[] = { SIGUSR1 };
    o11y_signal_options_t sopts = {
        .timeout_ms = 2000,
        .before_shutdown = on_before_shutdown,
        .before_shutdown_userdata = arg,
        .signals = sigs,
        .signals_len = 1,
    };
    o11y_shutdown_report_t report = {0};
    arg->rc = o11y_shutdown_on_signals(arg->sdk, &sopts, &report);
    return NULL;
}

static void test_shutdown_on_signals(void) {
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "sig-test";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));

    struct sig_test_arg arg = { .sdk = sdk, .before_called = 0, .rc = O11Y_ERR_TIMEOUT };
    pthread_t th;
    ASSERT_EQ_INT(0, pthread_create(&th, NULL, signal_waiter_thread, &arg));

    struct timespec ts = { .tv_sec = 0, .tv_nsec = 50000000L }; /* 50ms */
    nanosleep(&ts, NULL);
    ASSERT_EQ_INT(0, raise(SIGUSR1));

    ASSERT_EQ_INT(0, pthread_join(th, NULL));
    ASSERT_EQ_INT(1, atomic_load(&arg.before_called));
    ASSERT_EQ_ERR(O11Y_OK, arg.rc);
    o11y_destroy(sdk);
}

int main(void) {
    RUN_TEST(test_version_and_error_names);
    RUN_TEST(test_setup_typed_errors_and_diagnostics);
    RUN_TEST(test_double_setup_guard_and_idempotent_shutdown);
    RUN_TEST(test_env_precedence_and_sdk_resource_metadata);
    RUN_TEST(test_non_strict_identity_migration_mode);
    RUN_TEST(test_null_safety_never_crashes);
    RUN_TEST(test_shutdown_on_signals);
    TEST_SUMMARY("test_core");
}
