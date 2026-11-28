#define _POSIX_C_SOURCE 200809L

#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <unistd.h>

#include "o11y/test.h"
#include "test_framework.h"

static void test_version_and_error_names(void) {
    /* The headers and the linked library are the same release. */
    ASSERT_EQ_STR(O11Y_VERSION, o11y_version());
    char from_parts[32];
    snprintf(from_parts, sizeof(from_parts), "%d.%d.%d", O11Y_VERSION_MAJOR, O11Y_VERSION_MINOR, O11Y_VERSION_PATCH);
    ASSERT_EQ_STR(O11Y_VERSION, from_parts);
    ASSERT_EQ_STR("O11Y_OK", o11y_err_name(O11Y_OK));
    ASSERT_EQ_STR("O11Y_ERR_ALREADY_SETUP", o11y_err_name(O11Y_ERR_ALREADY_SETUP));
    ASSERT_EQ_STR("O11Y_ERR_NO_SERVICE_NAME", o11y_err_name(O11Y_ERR_NO_SERVICE_NAME));
    ASSERT_EQ_STR("O11Y_ERR_CANARY_REJECTED", o11y_err_name(O11Y_ERR_CANARY_REJECTED));
    ASSERT_EQ_STR("O11Y_ERR_UNSUPPORTED_PROPAGATOR", o11y_err_name(O11Y_ERR_UNSUPPORTED_PROPAGATOR));
    ASSERT_EQ_SIZE(sizeof(o11y_options_t), o11y_options_default().struct_size);
    ASSERT_EQ_SIZE(sizeof(o11y_test_options_t), o11y_test_options_default().struct_size);
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

    /* Zero-initialized options rejected safely instead of disabling strict_identity */
    o11y_options_t zero_opts;
    memset(&zero_opts, 0, sizeof(zero_opts));
    zero_opts.env_mode = O11Y_ENV_HERMETIC;
    diag.len = 0;
    diag.message[0] = '\0';
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&zero_opts, &sdk, &diag));
    ASSERT_NULL(sdk);
    ASSERT_TRUE(diag.len > 0);

    o11y_test_options_t zero_topts;
    memset(&zero_topts, 0, sizeof(zero_topts));
    o11y_test_recorder_t *zrec = NULL;
    diag.len = 0;
    diag.message[0] = '\0';
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_test_start(&zero_topts, &zrec, &diag));
    ASSERT_NULL(zrec);
    ASSERT_TRUE(diag.len > 0);

    /* NULL pointer with non-zero length rejected safely */
    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = NULL;
    opts.env_pairs_len = 1;
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);

    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_ENTRIES;
    opts.env_entries = NULL;
    opts.env_entries_len = 1;
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);

    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.resource_attributes = NULL;
    opts.resource_attributes_len = 1;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);

    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.app_registries = NULL;
    opts.app_registries_len = 1;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);

    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.propagators = NULL;
    opts.propagators_len = 1;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);

    opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "checkout";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.pii_mode = O11Y_PII_HASH;
    opts.pii_hash_key = NULL;
    opts.pii_hash_key_len = 32;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);
}

/* An enum value the header does not define fails setup instead of becoming a default. */
static void test_unknown_option_enums_fail_setup(void) {
    o11y_options_t base = o11y_options_default();
    base.env_mode = O11Y_ENV_HERMETIC;
    base.service_name = "checkout";
    base.environment = O11Y_ENVIRONMENT_TEST;
    base.console_enabled = false;
    base.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    o11y_diagnostic_t diag = {0};
    o11y_options_t opts;

    opts = base;
    opts.env_mode = (o11y_env_mode_t)99;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_NULL(sdk);
    ASSERT_STR_CONTAINS(diag.message, "env_mode");

    opts = base;
    opts.protocol = (o11y_protocol_t)99;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_STR_CONTAINS(diag.message, "protocol");

    opts = base;
    opts.log_level = (o11y_level_t)99;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_STR_CONTAINS(diag.message, "log_level");

    opts = base;
    opts.console_format = (o11y_console_format_t)99;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_STR_CONTAINS(diag.message, "console_format");

    opts = base;
    opts.console_target = (o11y_console_target_t)99;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_STR_CONTAINS(diag.message, "console_target");

    opts = base;
    opts.console_target = O11Y_CONSOLE_CUSTOM; /* without console_write_fn */
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_STR_CONTAINS(diag.message, "console_write_fn");

    opts = base;
    opts.pii_mode = (o11y_pii_mode_t)99;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_STR_CONTAINS(diag.message, "pii_mode");

    opts = base;
    opts.sampler_kind = (o11y_sampler_kind_t)99;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_STR_CONTAINS(diag.message, "sampler_kind");

    opts = base;
    opts.exemplar_filter = (o11y_exemplar_filter_t)99;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_init(&opts, &sdk, &diag));
    ASSERT_STR_CONTAINS(diag.message, "exemplar_filter");
    ASSERT_NULL(sdk);

    /* A later success clears the diagnostic. */
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&base, &sdk, &diag));
    ASSERT_NOT_NULL(sdk);
    ASSERT_EQ_SIZE(0, diag.len);
    ASSERT_EQ_STR("", diag.message);
    o11y_destroy(sdk);
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
    ASSERT_EQ_STR(O11Y_VERSION, o11y_test_span_resource_attr_str(recorded, "telemetry.sdk.version"));
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
    o11y_shutdown_report_t report = {
        .logs = O11Y_ERR_IO,
        .metrics = O11Y_ERR_TIMEOUT,
        .traces = O11Y_ERR_EXPORTER,
    };
    ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(NULL, 100, &report));
    ASSERT_EQ_ERR(O11Y_OK, report.logs);
    ASSERT_EQ_ERR(O11Y_OK, report.metrics);
    ASSERT_EQ_ERR(O11Y_OK, report.traces);

    report.logs = O11Y_ERR_IO;
    report.metrics = O11Y_ERR_TIMEOUT;
    report.traces = O11Y_ERR_EXPORTER;
    ASSERT_EQ_ERR(O11Y_OK, o11y_force_flush(NULL, 100, &report));
    ASSERT_EQ_ERR(O11Y_OK, report.logs);
    ASSERT_EQ_ERR(O11Y_OK, report.metrics);
    ASSERT_EQ_ERR(O11Y_OK, report.traces);

    o11y_trace_id_t zero_tid = {0};
    o11y_span_id_t zero_sid = {0};
    o11y_trace_id_hex(zero_tid, NULL);
    o11y_span_id_hex(zero_sid, NULL);

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

    /* Raise the signal only once the waiter has installed its handler. Until
     * then SIGUSR1 keeps its default action, which ends the process. */
    struct timespec ts = { .tv_sec = 0, .tv_nsec = 1000000L }; /* 1 ms */
    bool installed = false;
    for (int i = 0; i < 10000 && !installed; i++) {
        struct sigaction current;
        ASSERT_EQ_INT(0, sigaction(SIGUSR1, NULL, &current));
        installed = current.sa_handler != SIG_DFL;
        if (!installed) nanosleep(&ts, NULL);
    }
    ASSERT_TRUE(installed);
    ASSERT_EQ_INT(0, raise(SIGUSR1));

    ASSERT_EQ_INT(0, pthread_join(th, NULL));
    ASSERT_EQ_INT(1, atomic_load(&arg.before_called));
    ASSERT_EQ_ERR(O11Y_OK, arg.rc);

    /* Bad signal lists are refused without waiting. */
    int too_many[17] = {0};
    for (size_t i = 0; i < 17; i++) too_many[i] = SIGUSR1;
    o11y_signal_options_t bad = { .signals = too_many, .signals_len = 17 };
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown_on_signals(sdk, &bad, NULL));
    int out_of_range[] = { 0 };
    bad.signals = out_of_range;
    bad.signals_len = 1;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown_on_signals(sdk, &bad, NULL));
    bad.signals = NULL;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown_on_signals(sdk, &bad, NULL));

    /* Non-catchable and OS-invalid signals are rejected and zero out_report. */
    o11y_shutdown_report_t report = { .logs = O11Y_ERR_IO, .metrics = O11Y_ERR_IO, .traces = O11Y_ERR_IO };
    int bad_sigs_kill[] = { SIGKILL };
    bad.signals = bad_sigs_kill;
    bad.signals_len = 1;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown_on_signals(sdk, &bad, &report));
    ASSERT_TRUE(o11y_shutdown_report_ok(report));

    int bad_sigs_stop[] = { SIGSTOP };
    bad.signals = bad_sigs_stop;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown_on_signals(sdk, &bad, NULL));

    int bad_sigs_invalid[] = { 999 };
    bad.signals = bad_sigs_invalid;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown_on_signals(sdk, &bad, NULL));

    report.logs = O11Y_ERR_IO;
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown_on_signals(NULL, NULL, &report));
    ASSERT_TRUE(o11y_shutdown_report_ok(report));
    o11y_destroy(sdk);
}

static void dummy_sigpipe_handler(int sig) {
    (void)sig;
}

static void test_runtime_signal_restore_process_env_entries_disabled_and_build_info(void) {
    /* Destroying all handles restores prior SIGPIPE disposition. */
    struct sigaction custom = {0};
    struct sigaction prev_sigpipe = {0};
    custom.sa_handler = dummy_sigpipe_handler;
    sigemptyset(&custom.sa_mask);
    ASSERT_EQ_INT(0, sigaction(SIGPIPE, &custom, &prev_sigpipe));

    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "rt-check";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;
    opts.build_info.enabled = true;
    opts.build_info.version = "2.1.0";
    opts.build_info.revision = "deadbeef";
    opts.build_info.time = "2026-11-28T00:00:00Z";
    opts.build_info.modified_set = true;
    opts.build_info.modified = false;

    o11y_sdk_t *sdk = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    ASSERT_STR_CONTAINS(o11y_effective_config(sdk), "service.version=2.1.0");
    o11y_shutdown_report_t fl_rep = {0};
    ASSERT_EQ_ERR(O11Y_OK, o11y_force_flush(sdk, 1000, &fl_rep));
    ASSERT_TRUE(o11y_shutdown_report_ok(fl_rep));
    o11y_destroy(sdk);

    struct sigaction after = {0};
    ASSERT_EQ_INT(0, sigaction(SIGPIPE, NULL, &after));
    ASSERT_TRUE(after.sa_handler == dummy_sigpipe_handler);
    ASSERT_EQ_INT(0, sigaction(SIGPIPE, &prev_sigpipe, NULL));

    /* Recreate after last destroy to verify clean re-init. */
    o11y_test_recorder_t *rec = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_start(NULL, &rec, NULL));
    o11y_test_destroy(rec);

    /* O11Y_ENV_ENTRIES + OTEL_SDK_DISABLED=true */
    const char *entries[] = {
        "OTEL_SERVICE_NAME=entries-svc",
        "OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=staging",
        "OTEL_SDK_DISABLED=true",
        "OTEL_TRACES_EXPORTER=otlp",
    };
    o11y_options_t eopts = o11y_options_default();
    eopts.env_mode = O11Y_ENV_ENTRIES;
    eopts.env_entries = entries;
    eopts.env_entries_len = 4;
    eopts.console_enabled = false;
    eopts.runtime_metrics = false;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&eopts, &sdk, NULL));
    ASSERT_STR_CONTAINS(o11y_effective_config(sdk), "service.name=entries-svc");
    ASSERT_STR_CONTAINS(o11y_effective_config(sdk), "o11y.config.traces=none");
    o11y_destroy(sdk);

    /* O11Y_ENV_PROCESS reads OTEL_* from process environment cleanly */
    ASSERT_EQ_INT(0, setenv("OTEL_SERVICE_NAME", "proc-svc", 1));
    ASSERT_EQ_INT(0, setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=test", 1));
    ASSERT_EQ_INT(0, setenv("OTEL_TRACES_EXPORTER", "none", 1));
    ASSERT_EQ_INT(0, setenv("OTEL_METRICS_EXPORTER", "none", 1));
    ASSERT_EQ_INT(0, setenv("OTEL_LOGS_EXPORTER", "none", 1));
    ASSERT_EQ_INT(0, setenv("UNRELATED_SECRET_TOKEN", "do-not-retain", 1));

    o11y_options_t popts = o11y_options_default();
    popts.env_mode = O11Y_ENV_PROCESS;
    popts.console_enabled = false;
    popts.runtime_metrics = false;
    o11y_err_t prc = o11y_init(&popts, &sdk, NULL);
    unsetenv("OTEL_SERVICE_NAME");
    unsetenv("OTEL_RESOURCE_ATTRIBUTES");
    unsetenv("OTEL_TRACES_EXPORTER");
    unsetenv("OTEL_METRICS_EXPORTER");
    unsetenv("OTEL_LOGS_EXPORTER");
    unsetenv("UNRELATED_SECRET_TOKEN");
    ASSERT_EQ_ERR(O11Y_OK, prc);
    ASSERT_STR_CONTAINS(o11y_effective_config(sdk), "service.name=proc-svc");
    o11y_destroy(sdk);
}

int main(void) {
    RUN_TEST(test_version_and_error_names);
    RUN_TEST(test_setup_typed_errors_and_diagnostics);
    RUN_TEST(test_unknown_option_enums_fail_setup);
    RUN_TEST(test_double_setup_guard_and_idempotent_shutdown);
    RUN_TEST(test_env_precedence_and_sdk_resource_metadata);
    RUN_TEST(test_non_strict_identity_migration_mode);
    RUN_TEST(test_null_safety_never_crashes);
    RUN_TEST(test_shutdown_on_signals);
    RUN_TEST(test_runtime_signal_restore_process_env_entries_disabled_and_build_info);
    TEST_SUMMARY("test_core");
}
