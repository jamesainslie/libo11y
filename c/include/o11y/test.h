/*
 * libo11y test harness — hermetic recorder, conformance/correlation/triangle
 * assertions, and in-process OTLP/HTTP and OTLP/gRPC receivers for C11.
 *
 * Copyright 2026 libo11y contributors.
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef O11Y_TEST_H
#define O11Y_TEST_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "o11y/o11y.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct o11y_test_recorder o11y_test_recorder_t;
typedef struct o11y_test_span o11y_test_span_t;
typedef struct o11y_test_log o11y_test_log_t;
typedef struct o11y_test_report o11y_test_report_t;
typedef struct o11y_test_http_receiver o11y_test_http_receiver_t;
typedef struct o11y_test_grpc_receiver o11y_test_grpc_receiver_t;

/* =========================================================================
 * Hermetic Recorder
 * ========================================================================= */

typedef struct o11y_test_options {
    const char *service_name;
    const char *service_version;
    const char *service_namespace;
    const char *environment;
    const char *const *extra_environments;
    size_t extra_environments_len;
    bool strict_identity;

    const o11y_attr_t *resource_attributes;
    size_t resource_attributes_len;

    o11y_build_info_t build_info;

    o11y_level_t log_level;
    bool console_enabled;
    o11y_console_format_t console_format;
    bool log_export;

    o11y_attr_replacer_fn attr_replacer_fn;
    void *attr_replacer_userdata;
    const o11y_log_sink_t *extra_log_sinks;
    size_t extra_log_sinks_len;

    o11y_pii_mode_t pii_mode;
    const uint8_t *pii_hash_key;
    size_t pii_hash_key_len;

    const o11y_app_registry_source_t *app_registries;
    size_t app_registries_len;

    o11y_sampler_kind_t sampler_kind;
    double sampler_ratio;

    o11y_baggage_egress_allow_fn baggage_egress_allow;

    const o11y_histogram_buckets_t *histogram_buckets;
    size_t histogram_buckets_len;
    o11y_exemplar_filter_t exemplar_filter;

    bool runtime_metrics;
} o11y_test_options_t;

/** Returns defaults matching Go/Zig o11ytest (service="test-service", env="test", debug, always_on, trace_based, hermetic). */
o11y_test_options_t o11y_test_options_default(void);

o11y_err_t o11y_test_start(
    const o11y_test_options_t *options,
    o11y_test_recorder_t **out_rec,
    o11y_diagnostic_t *diag);

void o11y_test_destroy(o11y_test_recorder_t *rec);

/** Returns the underlying hermetic SDK handle (owned by rec). */
o11y_sdk_t *o11y_test_sdk(o11y_test_recorder_t *rec);

/** Clears captured spans, logs, OTLP logs, and console buffer. */
void o11y_test_reset(o11y_test_recorder_t *rec);

/* --- Spans --- */

size_t o11y_test_span_count(o11y_test_recorder_t *rec);
const o11y_test_span_t *o11y_test_span_at(o11y_test_recorder_t *rec, size_t index);
const o11y_test_span_t *o11y_test_find_span(o11y_test_recorder_t *rec, const char *name);

const char *o11y_test_span_name(const o11y_test_span_t *span);
o11y_span_kind_t o11y_test_span_kind(const o11y_test_span_t *span);
o11y_status_code_t o11y_test_span_status_code(const o11y_test_span_t *span);
const char *o11y_test_span_status_description(const o11y_test_span_t *span);
o11y_span_context_t o11y_test_span_context(const o11y_test_span_t *span);
o11y_span_context_t o11y_test_span_parent_context(const o11y_test_span_t *span);
bool o11y_test_span_has_attr(const o11y_test_span_t *span, const char *key);
const char *o11y_test_span_attr_str(const o11y_test_span_t *span, const char *key);
bool o11y_test_span_attr_int(const o11y_test_span_t *span, const char *key, int64_t *out);
bool o11y_test_span_attr_double(const o11y_test_span_t *span, const char *key, double *out);
bool o11y_test_span_attr_bool(const o11y_test_span_t *span, const char *key, bool *out);
size_t o11y_test_span_event_count(const o11y_test_span_t *span);
const char *o11y_test_span_event_name(const o11y_test_span_t *span, size_t index);
bool o11y_test_span_event_has_attr(const o11y_test_span_t *span, size_t event_index, const char *key);
const char *o11y_test_span_event_attr_str(const o11y_test_span_t *span, size_t event_index, const char *key);
size_t o11y_test_span_link_count(const o11y_test_span_t *span);
o11y_span_context_t o11y_test_span_link_context(const o11y_test_span_t *span, size_t index);
bool o11y_test_span_link_has_attr(const o11y_test_span_t *span, size_t link_index, const char *key);
const char *o11y_test_span_resource_schema_url(const o11y_test_span_t *span);
const char *o11y_test_span_resource_attr_str(const o11y_test_span_t *span, const char *key);

/* --- Logs --- */

size_t o11y_test_log_count(o11y_test_recorder_t *rec);
const o11y_test_log_t *o11y_test_log_at(o11y_test_recorder_t *rec, size_t index);
const o11y_test_log_t *o11y_test_find_log(o11y_test_recorder_t *rec, const char *message);
const o11y_test_log_t *o11y_test_find_event(o11y_test_recorder_t *rec, const char *event_name);

const char *o11y_test_log_message(const o11y_test_log_t *log);
o11y_level_t o11y_test_log_level(const o11y_test_log_t *log);
o11y_span_context_t o11y_test_log_span_context(const o11y_test_log_t *log);
bool o11y_test_log_has_attr(const o11y_test_log_t *log, const char *key);
const char *o11y_test_log_attr_str(const o11y_test_log_t *log, const char *key);
bool o11y_test_log_attr_int(const o11y_test_log_t *log, const char *key, int64_t *out);
bool o11y_test_log_attr_double(const o11y_test_log_t *log, const char *key, double *out);
bool o11y_test_log_attr_bool(const o11y_test_log_t *log, const char *key, bool *out);

/** Returns a snapshot of captured console bytes (NUL-terminated; valid until reset/destroy). */
const char *o11y_test_console_output(o11y_test_recorder_t *rec, size_t *out_len);
/** Flushes and returns count of exported OTLP log records. */
size_t o11y_test_otlp_log_count(o11y_test_recorder_t *rec);

/* --- Metrics & Exemplars --- */

typedef struct o11y_test_exemplar {
    o11y_trace_id_t trace_id;
    o11y_span_id_t span_id;
    double value;
    uint64_t time_unix_nano;
} o11y_test_exemplar_t;

bool o11y_test_has_metric(o11y_test_recorder_t *rec, const char *name);
/** Sums all int64 data points for a Sum or Gauge metric; returns false if absent. */
bool o11y_test_metric_sum_i64(o11y_test_recorder_t *rec, const char *name, int64_t *out);
/** Sums all float64 data points for a Sum or Gauge metric; returns false if absent. */
bool o11y_test_metric_sum_f64(o11y_test_recorder_t *rec, const char *name, double *out);
/** Sums histogram sample counts across all data points; returns false if absent. */
bool o11y_test_metric_histogram_count(o11y_test_recorder_t *rec, const char *name, uint64_t *out);
/** Reports whether any data point of metric name carries attribute key. */
bool o11y_test_metric_has_attr(o11y_test_recorder_t *rec, const char *name, const char *attr_key);

size_t o11y_test_exemplar_count(o11y_test_recorder_t *rec, const char *metric_name);
bool o11y_test_exemplar_at(
    o11y_test_recorder_t *rec,
    const char *metric_name,
    size_t index,
    o11y_test_exemplar_t *out);

/* --- Violations & Conformance Reports --- */

/** Sums o11y.schema.violations matching optional signal ("traces"/"metrics"/"logs"/"resource" or NULL) and rule (or NULL). */
int64_t o11y_test_violations(o11y_test_recorder_t *rec, const char *signal, const char *rule);

o11y_test_report_t *o11y_test_check_conforms(o11y_test_recorder_t *rec);
o11y_test_report_t *o11y_test_check_correlated(o11y_test_recorder_t *rec);
o11y_test_report_t *o11y_test_check_triangle(o11y_test_recorder_t *rec, const char *metric_name);

bool o11y_test_report_ok(const o11y_test_report_t *report);
size_t o11y_test_report_count(const o11y_test_report_t *report);
const char *o11y_test_report_problem(const o11y_test_report_t *report, size_t index);
void o11y_test_report_destroy(o11y_test_report_t *report);

/* =========================================================================
 * In-Process OTLP/HTTP and OTLP/gRPC Receivers (for wire tests)
 * ========================================================================= */

typedef struct o11y_test_tls_options {
    bool enabled;
    /** PEM cert/key; NULL defaults to built-in loopback test certs. */
    const char *cert_pem;
    const char *key_pem;
    /** Optional client CA PEM to require mutual TLS. */
    const char *client_ca_pem;
} o11y_test_tls_options_t;

typedef struct o11y_test_http_reply {
    uint16_t status;
    const char *retry_after;
    const char *body;
    size_t body_len;
    const char *content_type;
    uint64_t delay_ms;
    bool hang;
    bool close_after;
} o11y_test_http_reply_t;

typedef struct o11y_test_http_receiver_options {
    const o11y_test_http_reply_t *replies;
    size_t replies_len;
    o11y_test_tls_options_t tls;
} o11y_test_http_receiver_options_t;

o11y_err_t o11y_test_http_receiver_start(
    const o11y_test_http_receiver_options_t *options,
    o11y_test_http_receiver_t **out_rx);
void o11y_test_http_receiver_destroy(o11y_test_http_receiver_t *rx);
const char *o11y_test_http_receiver_url(const o11y_test_http_receiver_t *rx);
size_t o11y_test_http_receiver_request_count(o11y_test_http_receiver_t *rx);
size_t o11y_test_http_receiver_span_count(o11y_test_http_receiver_t *rx);
size_t o11y_test_http_receiver_metric_count(o11y_test_http_receiver_t *rx);
size_t o11y_test_http_receiver_log_count(o11y_test_http_receiver_t *rx);
size_t o11y_test_http_receiver_decode_errors(o11y_test_http_receiver_t *rx);
bool o11y_test_http_receiver_wait_requests(
    o11y_test_http_receiver_t *rx,
    size_t min_count,
    uint64_t timeout_ms);

typedef struct o11y_test_grpc_reply {
    uint16_t http_status;
    uint32_t grpc_status;
    const char *grpc_message;
    uint64_t delay_ms;
    bool hang;
} o11y_test_grpc_reply_t;

typedef struct o11y_test_grpc_receiver_options {
    const o11y_test_grpc_reply_t *replies;
    size_t replies_len;
    o11y_test_tls_options_t tls;
} o11y_test_grpc_receiver_options_t;

o11y_err_t o11y_test_grpc_receiver_start(
    const o11y_test_grpc_receiver_options_t *options,
    o11y_test_grpc_receiver_t **out_rx);
void o11y_test_grpc_receiver_destroy(o11y_test_grpc_receiver_t *rx);
const char *o11y_test_grpc_receiver_endpoint(const o11y_test_grpc_receiver_t *rx);
size_t o11y_test_grpc_receiver_request_count(o11y_test_grpc_receiver_t *rx);
size_t o11y_test_grpc_receiver_span_count(o11y_test_grpc_receiver_t *rx);
size_t o11y_test_grpc_receiver_metric_count(o11y_test_grpc_receiver_t *rx);
size_t o11y_test_grpc_receiver_log_count(o11y_test_grpc_receiver_t *rx);
size_t o11y_test_grpc_receiver_decode_errors(o11y_test_grpc_receiver_t *rx);
bool o11y_test_grpc_receiver_wait_requests(
    o11y_test_grpc_receiver_t *rx,
    size_t min_count,
    uint64_t timeout_ms);

/** Built-in self-signed loopback TLS certificates (PEM, NUL-terminated). */
const char *o11y_test_cert_ca_pem(void);
const char *o11y_test_cert_server_pem(void);
const char *o11y_test_cert_server_key_pem(void);
const char *o11y_test_cert_client_pem(void);
const char *o11y_test_cert_client_key_pem(void);
const char *o11y_test_cert_other_ca_pem(void);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* O11Y_TEST_H */
