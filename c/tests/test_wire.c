/*
 * End-to-end OTLP wire tests over loopback from C11:
 *   - OTLP/HTTP (http/protobuf + gzip, and http/json)
 *   - OTLP/HTTP over TLS and mutual TLS (mTLS)
 *   - OTLP/HTTP retry on HTTP 503
 *   - OTLP/gRPC over HTTP/2 (h2c)
 *   - OTLP/gRPC over TLS (ALPN h2) + mutual TLS (mTLS)
 */

#define _DARWIN_C_SOURCE
#define _XOPEN_SOURCE 700

#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/socket.h>
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

static int open_hanging_loopback_listener(uint16_t *out_port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    if (bind(fd, (const struct sockaddr *)&addr, sizeof(addr)) != 0 ||
        listen(fd, 4) != 0) {
        close(fd);
        return -1;
    }
    socklen_t len = sizeof(addr);
    if (getsockname(fd, (struct sockaddr *)&addr, &len) != 0) {
        close(fd);
        return -1;
    }
    *out_port = ntohs(addr.sin_port);
    return fd;
}

static void test_cross_library_signal_refcount_both_orders(void) {
#ifdef SIGIO
    struct sigaction saved_sigio = {0};
    ASSERT_EQ_INT(0, sigaction(SIGIO, NULL, &saved_sigio));
    struct sigaction dfl = {0};
    dfl.sa_handler = SIG_DFL;
    sigemptyset(&dfl.sa_mask);
    ASSERT_EQ_INT(0, sigaction(SIGIO, &dfl, NULL));
#endif

    /* Order A: start receiver first, start networked SDK second pointing at a
     * silent TCP listener, destroy receiver first, then trigger a real SIGIO
     * export cancellation in o11y_shutdown while the SDK is still live. */
    uint16_t hang_port = 0;
    int listen_fd = open_hanging_loopback_listener(&hang_port);
    ASSERT_TRUE(listen_fd >= 0);
    char endpoint[64];
    snprintf(endpoint, sizeof(endpoint), "http://127.0.0.1:%u", (unsigned)hang_port);

    o11y_test_http_receiver_t *rx = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_http_receiver_start(NULL, &rx));
    ASSERT_NOT_NULL(rx);

    o11y_env_pair_t hang_env[] = {
        { "OTEL_EXPORTER_OTLP_ENDPOINT", endpoint },
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf" },
        { "OTEL_METRICS_EXPORTER", "none" },
        { "OTEL_LOGS_EXPORTER", "none" },
    };
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = hang_env;
    opts.env_pairs_len = 4;
    opts.service_name = "c-sigio-order-a";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    ASSERT_NOT_NULL(sdk);

    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "sigio"), NULL, "hang-op", NULL);
    o11y_span_end(sp);

#if defined(SIGIO) && defined(SIGUSR1)
    /* Reject runtime-reserved SIGIO even when paired with an allowed signal. */
    int reserved_sigs[] = { SIGUSR1, SIGIO };
    o11y_signal_options_t sig_opts = {
        .signals = reserved_sigs,
        .signals_len = 2,
        .timeout_ms = 50,
    };
    o11y_shutdown_report_t sig_rep = { .logs = O11Y_ERR_IO };
    ASSERT_EQ_ERR(O11Y_ERR_INVALID_ARGUMENT, o11y_shutdown_on_signals(sdk, &sig_opts, &sig_rep));
    ASSERT_TRUE(o11y_shutdown_report_ok(sig_rep));
    struct sigaction sigio_after_refusal = {0};
    ASSERT_EQ_INT(0, sigaction(SIGIO, NULL, &sigio_after_refusal));
    ASSERT_TRUE(sigio_after_refusal.sa_handler != SIG_DFL);
#endif

    /* Destroy receiver while SDK stays live: SIGIO must stay guarded. */
    o11y_test_http_receiver_destroy(rx);
#ifdef SIGIO
    struct sigaction cur_sigio = {0};
    ASSERT_EQ_INT(0, sigaction(SIGIO, NULL, &cur_sigio));
    ASSERT_TRUE(cur_sigio.sa_handler != SIG_DFL);
#endif

    o11y_shutdown_report_t report = {0};
    o11y_err_t serr = o11y_shutdown(sdk, 150, &report);
    ASSERT_TRUE(serr != O11Y_OK);
    o11y_destroy(sdk);
    close(listen_fd);
#ifdef SIGIO
    ASSERT_EQ_INT(0, sigaction(SIGIO, NULL, &cur_sigio));
    ASSERT_TRUE(cur_sigio.sa_handler == SIG_DFL);
#endif

    /* Order B: start networked SDK first, start receiver second, destroy SDK
     * first, then destroy receiver (cancelling its accept loop via SIGIO). */
    o11y_env_pair_t none_env[] = {
        { "OTEL_TRACES_EXPORTER", "none" },
        { "OTEL_METRICS_EXPORTER", "none" },
        { "OTEL_LOGS_EXPORTER", "none" },
    };
    opts.env_pairs = none_env;
    opts.env_pairs_len = 3;
    opts.service_name = "c-sigio-order-b";
    ASSERT_EQ_ERR(O11Y_OK, o11y_init(&opts, &sdk, NULL));
    ASSERT_NOT_NULL(sdk);

    rx = NULL;
    ASSERT_EQ_ERR(O11Y_OK, o11y_test_http_receiver_start(NULL, &rx));
    ASSERT_NOT_NULL(rx);

    o11y_destroy(sdk);
#ifdef SIGIO
    ASSERT_EQ_INT(0, sigaction(SIGIO, NULL, &cur_sigio));
    ASSERT_TRUE(cur_sigio.sa_handler != SIG_DFL);
#endif
    o11y_test_http_receiver_destroy(rx);
#ifdef SIGIO
    ASSERT_EQ_INT(0, sigaction(SIGIO, NULL, &cur_sigio));
    ASSERT_TRUE(cur_sigio.sa_handler == SIG_DFL);
    ASSERT_EQ_INT(0, sigaction(SIGIO, &saved_sigio, NULL));
#endif
}

int main(void) {
    RUN_TEST(test_otlp_http_protobuf_and_gzip);
    RUN_TEST(test_otlp_http_json_and_retry);
    RUN_TEST(test_otlp_http_mtls);
    RUN_TEST(test_otlp_grpc_h2c_and_mtls);
    RUN_TEST(test_receiver_validation_and_error_handler);
    RUN_TEST(test_cross_library_signal_refcount_both_orders);
    TEST_SUMMARY("test_wire");
}
