/*
 * End-to-end OTLP wire tests over loopback from C11:
 *   - OTLP/HTTP (http/protobuf + gzip, and http/json)
 *   - OTLP/HTTP over TLS and mutual TLS (mTLS)
 *   - OTLP/HTTP retry on HTTP 503
 *   - OTLP/gRPC over HTTP/2 (h2c)
 *   - OTLP/gRPC over TLS (ALPN h2) + mutual TLS (mTLS)
 */

#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include "o11y/test.h"
#include "test_framework.h"

static bool write_text_file(const char *path, const char *content) {
    FILE *f = fopen(path, "wb");
    if (!f) return false;
    size_t len = strlen(content);
    bool ok = fwrite(content, 1, len, f) == len;
    fclose(f);
    return ok;
}

static void emit_three_signals(o11y_sdk_t *sdk) {
    o11y_tracer_t *tr = o11y_tracer(sdk, "wire-test");
    o11y_meter_t *m = o11y_meter(sdk, "wire-test");
    o11y_counter_i64_t c = o11y_meter_counter_i64(m, "wire.requests", NULL);

    o11y_span_t *sp = o11y_tracer_start(tr, NULL, "wire-op", NULL);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, sp);
    o11y_log_info(sdk, ctx, "wire-log", NULL, 0);
    o11y_counter_i64_add(c, ctx, 1, NULL, 0);
    o11y_ctx_destroy(ctx);
    o11y_span_end(sp);
}

static void test_otlp_http_protobuf_and_gzip(void) {
    o11y_test_http_receiver_t *rx = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_http_receiver_start(NULL, &rx));
    ASSERT_NOT_NULL(rx);

    o11y_env_pair_t env_pairs[] = {
        { "OTEL_EXPORTER_OTLP_ENDPOINT", o11y_test_http_receiver_url(rx) },
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf" },
        { "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip" },
    };

    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = env_pairs;
    opts.env_pairs_len = 3;
    opts.service_name = "c-wire-http";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    emit_three_signals(sdk);

    /* Default OTLP initial retry backoff is 5s +/- 50% (2.5s..7.5s), so allow 10s. */
    o11y_shutdown_report_t report = {0};
    ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(sdk, 10000, &report));
    ASSERT_TRUE(o11y_shutdown_report_ok(report));
    o11y_destroy(sdk);

    ASSERT_EQ_SIZE(0, o11y_test_http_receiver_decode_errors(rx));
    ASSERT_TRUE(o11y_test_http_receiver_span_count(rx) >= 1);
    ASSERT_TRUE(o11y_test_http_receiver_metric_count(rx) >= 1);
    ASSERT_TRUE(o11y_test_http_receiver_log_count(rx) >= 1);

    o11y_test_http_receiver_destroy(rx);
}

static void test_otlp_http_json_and_retry(void) {
    o11y_test_http_reply_t replies[] = {
        { .status = 503, .retry_after = "0", .content_type = "application/json" },
        { .status = 200, .content_type = "application/json" },
    };
    o11y_test_http_receiver_options_t ropts = {
        .replies = replies,
        .replies_len = 2,
    };
    o11y_test_http_receiver_t *rx = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_http_receiver_start(&ropts, &rx));

    o11y_env_pair_t env_pairs[] = {
        { "OTEL_EXPORTER_OTLP_ENDPOINT", o11y_test_http_receiver_url(rx) },
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "http/json" },
        { "OTEL_METRICS_EXPORTER", "none" },
        { "OTEL_LOGS_EXPORTER", "none" },
    };
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = env_pairs;
    opts.env_pairs_len = 4;
    opts.service_name = "c-wire-json";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "json"), NULL, "retry-op", NULL);
    o11y_span_end(sp);

    /* Default OTLP initial retry backoff is 5s +/- 50% (2.5s..7.5s), so allow 10s. */
    o11y_shutdown_report_t report = {0};
    ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(sdk, 10000, &report));
    ASSERT_TRUE(o11y_shutdown_report_ok(report));
    o11y_destroy(sdk);

    /* First attempt got 503, retry succeeded on second request */
    ASSERT_TRUE(o11y_test_http_receiver_request_count(rx) >= 2);
    ASSERT_EQ_SIZE(0, o11y_test_http_receiver_decode_errors(rx));
    ASSERT_TRUE(o11y_test_http_receiver_span_count(rx) >= 1);

    o11y_test_http_receiver_destroy(rx);
}

static void test_otlp_http_mtls(void) {
    char tmp_dir[] = "/tmp/libo11y-c-mtls-XXXXXX";
    ASSERT_NOT_NULL(mkdtemp(tmp_dir));

    char ca_path[256], cert_path[256], key_path[256];
    snprintf(ca_path, sizeof(ca_path), "%s/ca.pem", tmp_dir);
    snprintf(cert_path, sizeof(cert_path), "%s/client.pem", tmp_dir);
    snprintf(key_path, sizeof(key_path), "%s/client-key.pem", tmp_dir);
    ASSERT_TRUE(write_text_file(ca_path, o11y_test_cert_ca_pem()));
    ASSERT_TRUE(write_text_file(cert_path, o11y_test_cert_client_pem()));
    ASSERT_TRUE(write_text_file(key_path, o11y_test_cert_client_key_pem()));

    o11y_test_http_receiver_options_t ropts = {
        .tls = {
            .enabled = true,
            .client_ca_pem = o11y_test_cert_ca_pem(),
        },
    };
    o11y_test_http_receiver_t *rx = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_http_receiver_start(&ropts, &rx));

    o11y_env_pair_t env_pairs[] = {
        { "OTEL_EXPORTER_OTLP_ENDPOINT", o11y_test_http_receiver_url(rx) },
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf" },
        { "OTEL_EXPORTER_OTLP_CERTIFICATE", ca_path },
        { "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", cert_path },
        { "OTEL_EXPORTER_OTLP_CLIENT_KEY", key_path },
    };
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = env_pairs;
    opts.env_pairs_len = 5;
    opts.service_name = "c-wire-mtls";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    emit_three_signals(sdk);

    /* Default OTLP initial retry backoff is 5s +/- 50% (2.5s..7.5s), so allow 10s. */
    o11y_shutdown_report_t report = {0};
    ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(sdk, 10000, &report));
    ASSERT_TRUE(o11y_shutdown_report_ok(report));
    o11y_destroy(sdk);

    ASSERT_EQ_SIZE(0, o11y_test_http_receiver_decode_errors(rx));
    ASSERT_TRUE(o11y_test_http_receiver_span_count(rx) >= 1);
    ASSERT_TRUE(o11y_test_http_receiver_metric_count(rx) >= 1);
    ASSERT_TRUE(o11y_test_http_receiver_log_count(rx) >= 1);

    o11y_test_http_receiver_destroy(rx);
    unlink(ca_path);
    unlink(cert_path);
    unlink(key_path);
    rmdir(tmp_dir);
}

static void test_otlp_grpc_h2c_and_mtls(void) {
    /* 1. Plain h2c */
    o11y_test_grpc_receiver_t *rx = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_grpc_receiver_start(NULL, &rx));

    o11y_env_pair_t env_h2c[] = {
        { "OTEL_EXPORTER_OTLP_ENDPOINT", o11y_test_grpc_receiver_endpoint(rx) },
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc" },
        { "OTEL_EXPORTER_OTLP_COMPRESSION", "gzip" },
    };
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = env_h2c;
    opts.env_pairs_len = 3;
    opts.service_name = "c-wire-grpc";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    emit_three_signals(sdk);

    /* Default OTLP initial retry backoff is 5s +/- 50% (2.5s..7.5s), so allow 10s. */
    o11y_shutdown_report_t report = {0};
    ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(sdk, 10000, &report));
    ASSERT_TRUE(o11y_shutdown_report_ok(report));
    o11y_destroy(sdk);

    ASSERT_EQ_SIZE(0, o11y_test_grpc_receiver_decode_errors(rx));
    ASSERT_TRUE(o11y_test_grpc_receiver_span_count(rx) >= 1);
    ASSERT_TRUE(o11y_test_grpc_receiver_metric_count(rx) >= 1);
    ASSERT_TRUE(o11y_test_grpc_receiver_log_count(rx) >= 1);
    o11y_test_grpc_receiver_destroy(rx);

    /* 2. TLS ALPN h2 + mTLS */
    char tmp_dir[] = "/tmp/libo11y-c-grpc-XXXXXX";
    ASSERT_NOT_NULL(mkdtemp(tmp_dir));

    char ca_path[256], cert_path[256], key_path[256];
    snprintf(ca_path, sizeof(ca_path), "%s/ca.pem", tmp_dir);
    snprintf(cert_path, sizeof(cert_path), "%s/client.pem", tmp_dir);
    snprintf(key_path, sizeof(key_path), "%s/client-key.pem", tmp_dir);
    ASSERT_TRUE(write_text_file(ca_path, o11y_test_cert_ca_pem()));
    ASSERT_TRUE(write_text_file(cert_path, o11y_test_cert_client_pem()));
    ASSERT_TRUE(write_text_file(key_path, o11y_test_cert_client_key_pem()));

    o11y_test_grpc_receiver_options_t gropts = {
        .tls = {
            .enabled = true,
            .client_ca_pem = o11y_test_cert_ca_pem(),
        },
    };
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_grpc_receiver_start(&gropts, &rx));

    o11y_env_pair_t env_tls[] = {
        { "OTEL_EXPORTER_OTLP_ENDPOINT", o11y_test_grpc_receiver_endpoint(rx) },
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "grpc" },
        { "OTEL_EXPORTER_OTLP_CERTIFICATE", ca_path },
        { "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", cert_path },
        { "OTEL_EXPORTER_OTLP_CLIENT_KEY", key_path },
    };
    opts.env_pairs = env_tls;
    opts.env_pairs_len = 5;

    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    emit_three_signals(sdk);

    ASSERT_EQ_ERR(O11Y_OK, o11y_shutdown(sdk, 5000, &report));
    ASSERT_TRUE(o11y_shutdown_report_ok(report));
    o11y_destroy(sdk);

    ASSERT_EQ_SIZE(0, o11y_test_grpc_receiver_decode_errors(rx));
    ASSERT_TRUE(o11y_test_grpc_receiver_span_count(rx) >= 1);
    ASSERT_TRUE(o11y_test_grpc_receiver_metric_count(rx) >= 1);
    ASSERT_TRUE(o11y_test_grpc_receiver_log_count(rx) >= 1);
    o11y_test_grpc_receiver_destroy(rx);

    unlink(ca_path);
    unlink(cert_path);
    unlink(key_path);
    rmdir(tmp_dir);
}

struct error_handler_state {
    int calls;
    char last_msg[256];
};

static void on_export_error(void *userdata, const char *message) {
    struct error_handler_state *st = (struct error_handler_state *)userdata;
    st->calls++;
    if (message != NULL) {
        snprintf(st->last_msg, sizeof(st->last_msg), "%s", message);
    }
}

static void test_receiver_validation_and_error_handler(void) {
    /* Partial TLS rejected by both HTTP and gRPC receivers */
    o11y_test_http_receiver_t *hrx = NULL;
    o11y_test_http_receiver_options_t bad_http_tls = {
        .tls = { .enabled = true, .cert_pem = o11y_test_cert_server_pem(), .key_pem = NULL },
    };
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_test_http_receiver_start(&bad_http_tls, &hrx));
    ASSERT_NULL(hrx);

    o11y_test_http_receiver_options_t bad_http_replies = { .replies = NULL, .replies_len = 1 };
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_test_http_receiver_start(&bad_http_replies, &hrx));
    ASSERT_NULL(hrx);

    o11y_test_grpc_receiver_t *grx = NULL;
    o11y_test_grpc_receiver_options_t bad_grpc_tls = {
        .tls = { .enabled = true, .cert_pem = NULL, .key_pem = o11y_test_cert_server_key_pem() },
    };
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_test_grpc_receiver_start(&bad_grpc_tls, &grx));
    ASSERT_NULL(grx);

    /* Error handler invoked on rejected HTTP export */
    o11y_test_http_reply_t fail_reply[] = {
        { .status = 400 },
    };
    o11y_test_http_receiver_options_t fail_opts = { .replies = fail_reply, .replies_len = 1 };
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_http_receiver_start(&fail_opts, &hrx));

    struct error_handler_state eh = {0};
    o11y_env_pair_t env_pairs[] = {
        { "OTEL_EXPORTER_OTLP_ENDPOINT", o11y_test_http_receiver_url(hrx) },
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf" },
        { "OTEL_METRICS_EXPORTER", "none" },
        { "OTEL_LOGS_EXPORTER", "none" },
    };
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = env_pairs;
    opts.env_pairs_len = 4;
    opts.service_name = "c-eh-test";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;
    opts.error_handler_fn = on_export_error;
    opts.error_handler_userdata = &eh;

    o11y_sdk_t *sdk = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "eh"), NULL, "op", NULL);
    o11y_span_end(sp);
    o11y_shutdown_report_t report = {0};
    (void)o11y_shutdown(sdk, 3000, &report);
    o11y_destroy(sdk);

    ASSERT_TRUE(eh.calls >= 1);
    ASSERT_TRUE(eh.last_msg[0] != '\0');
    o11y_test_http_receiver_destroy(hrx);
}

int main(void) {
    RUN_TEST(test_otlp_http_protobuf_and_gzip);
    RUN_TEST(test_otlp_http_json_and_retry);
    RUN_TEST(test_otlp_http_mtls);
    RUN_TEST(test_otlp_grpc_h2c_and_mtls);
    RUN_TEST(test_receiver_validation_and_error_handler);
    TEST_SUMMARY("test_wire");
}
