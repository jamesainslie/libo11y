/*
 * libo11y — Opinionated, elegant observability for C11 built on OpenTelemetry.
 *
 * Copyright 2026 libo11y contributors.
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef O11Y_H
#define O11Y_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "o11y/spec.h"

#ifdef __cplusplus
extern "C" {
#endif

/* =========================================================================
 * Version & error codes
 * ========================================================================= */

/** Returns the libo11y C library semantic version (e.g. "0.1.0"). */
const char *o11y_version(void);

/** Typed error codes returned by fallible libo11y C API calls. */
typedef enum o11y_err {
    O11Y_OK = 0,
    O11Y_ERR_ALREADY_SETUP = 1,
    O11Y_ERR_NO_SERVICE_NAME = 2,
    O11Y_ERR_NO_ENVIRONMENT = 3,
    O11Y_ERR_INVALID_ENVIRONMENT = 4,
    O11Y_ERR_PII_HASH_KEY = 5,
    O11Y_ERR_INVALID_APP_REGISTRY = 6,
    O11Y_ERR_CANARY_REJECTED = 7,
    O11Y_ERR_UNSUPPORTED_PROTOCOL = 8,
    O11Y_ERR_EXPORTER = 9,
    O11Y_ERR_OUT_OF_MEMORY = 10,
    O11Y_ERR_INVALID_ARGUMENT = 11,
    O11Y_ERR_INVALID_CARRIER = 12,
    O11Y_ERR_TIMEOUT = 13,
    O11Y_ERR_SHUTDOWN = 14,
    O11Y_ERR_NOT_FOUND = 15,
    O11Y_ERR_CONFORMANCE_FAILED = 16,
    O11Y_ERR_CORRELATION_FAILED = 17,
    O11Y_ERR_TRIANGLE_FAILED = 18,
    O11Y_ERR_VIOLATIONS = 19,
    O11Y_ERR_IO = 20
} o11y_err_t;

/** Returns a static human-readable name for err (never NULL). */
const char *o11y_err_name(o11y_err_t err);

/** Stack-allocatable diagnostic buffer populated on setup/init failures. */
typedef struct o11y_diagnostic {
    char message[1024];
    size_t len;
} o11y_diagnostic_t;

/** Frees a heap string returned by libo11y (NULL-safe). */
void o11y_string_free(char *s);

/* =========================================================================
 * Opaque handles
 * ========================================================================= */

typedef struct o11y_sdk o11y_sdk_t;
typedef struct o11y_ctx o11y_ctx_t;
typedef struct o11y_tracer o11y_tracer_t;
typedef struct o11y_span o11y_span_t;
typedef struct o11y_meter o11y_meter_t;
typedef struct o11y_record o11y_record_t;
typedef struct o11y_detached_carrier o11y_detached_carrier_t;
typedef struct o11y_linked_span o11y_linked_span_t;
typedef struct o11y_registration o11y_registration_t;

/* =========================================================================
 * Trace & Span IDs
 * ========================================================================= */

typedef struct o11y_trace_id {
    uint8_t bytes[16];
} o11y_trace_id_t;

typedef struct o11y_span_id {
    uint8_t bytes[8];
} o11y_span_id_t;

typedef struct o11y_span_context {
    o11y_trace_id_t trace_id;
    o11y_span_id_t span_id;
    uint8_t trace_flags;
    bool remote;
    /** Optional NUL-terminated W3C tracestate header (NULL or "" when empty). */
    const char *trace_state;
} o11y_span_context_t;

bool o11y_trace_id_is_valid(o11y_trace_id_t id);
bool o11y_span_id_is_valid(o11y_span_id_t id);
bool o11y_span_context_is_valid(o11y_span_context_t sc);
bool o11y_span_context_is_sampled(o11y_span_context_t sc);
void o11y_trace_id_hex(o11y_trace_id_t id, char out[33]);
void o11y_span_id_hex(o11y_span_id_t id, char out[17]);
bool o11y_trace_id_parse_hex(const char *hex, o11y_trace_id_t *out);
bool o11y_span_id_parse_hex(const char *hex, o11y_span_id_t *out);

/* =========================================================================
 * Attributes (spans, metrics, resources)
 * ========================================================================= */

typedef enum o11y_attr_kind {
    O11Y_ATTR_STRING = 0,
    O11Y_ATTR_BOOL = 1,
    O11Y_ATTR_INT = 2,
    O11Y_ATTR_DOUBLE = 3,
    O11Y_ATTR_STRING_ARRAY = 4,
    O11Y_ATTR_BOOL_ARRAY = 5,
    O11Y_ATTR_INT_ARRAY = 6,
    O11Y_ATTR_DOUBLE_ARRAY = 7
} o11y_attr_kind_t;

typedef struct o11y_attr {
    const char *key;
    o11y_attr_kind_t kind;
    union {
        const char *str_val;
        bool bool_val;
        int64_t int_val;
        double double_val;
        struct {
            const char *const *items;
            size_t len;
        } str_array;
        struct {
            const bool *items;
            size_t len;
        } bool_array;
        struct {
            const int64_t *items;
            size_t len;
        } int_array;
        struct {
            const double *items;
            size_t len;
        } double_array;
    } value;
} o11y_attr_t;

static inline o11y_attr_t o11y_kv_str(const char *key, const char *val) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_STRING;
    a.value.str_val = val;
    return a;
}

static inline o11y_attr_t o11y_kv_bool(const char *key, bool val) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_BOOL;
    a.value.bool_val = val;
    return a;
}

static inline o11y_attr_t o11y_kv_int(const char *key, int64_t val) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_INT;
    a.value.int_val = val;
    return a;
}

static inline o11y_attr_t o11y_kv_double(const char *key, double val) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_DOUBLE;
    a.value.double_val = val;
    return a;
}

static inline o11y_attr_t o11y_kv_str_array(const char *key, const char *const *items, size_t len) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_STRING_ARRAY;
    a.value.str_array.items = items;
    a.value.str_array.len = len;
    return a;
}

static inline o11y_attr_t o11y_kv_bool_array(const char *key, const bool *items, size_t len) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_BOOL_ARRAY;
    a.value.bool_array.items = items;
    a.value.bool_array.len = len;
    return a;
}

static inline o11y_attr_t o11y_kv_int_array(const char *key, const int64_t *items, size_t len) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_INT_ARRAY;
    a.value.int_array.items = items;
    a.value.int_array.len = len;
    return a;
}

static inline o11y_attr_t o11y_kv_double_array(const char *key, const double *items, size_t len) {
    o11y_attr_t a;
    a.key = key;
    a.kind = O11Y_ATTR_DOUBLE_ARRAY;
    a.value.double_array.items = items;
    a.value.double_array.len = len;
    return a;
}

/* =========================================================================
 * Structured log values & attributes (supports nested arrays, maps, bytes)
 * ========================================================================= */

typedef enum o11y_log_value_kind {
    O11Y_LOG_VAL_EMPTY = 0,
    O11Y_LOG_VAL_STRING = 1,
    O11Y_LOG_VAL_BOOL = 2,
    O11Y_LOG_VAL_INT = 3,
    O11Y_LOG_VAL_DOUBLE = 4,
    O11Y_LOG_VAL_BYTES = 5,
    O11Y_LOG_VAL_ARRAY = 6,
    O11Y_LOG_VAL_MAP = 7
} o11y_log_value_kind_t;

typedef struct o11y_log_attr o11y_log_attr_t;

typedef struct o11y_log_value {
    o11y_log_value_kind_t kind;
    union {
        struct {
            const char *data;
            size_t len;
            bool has_len; /* if false, data is NUL-terminated */
        } str_val;
        bool bool_val;
        int64_t int_val;
        double double_val;
        struct {
            const uint8_t *data;
            size_t len;
        } bytes_val;
        struct {
            const struct o11y_log_value *items;
            size_t len;
        } array_val;
        struct {
            const o11y_log_attr_t *items;
            size_t len;
        } map_val;
    } value;
} o11y_log_value_t;

struct o11y_log_attr {
    const char *key;
    o11y_log_value_t value;
};

static inline o11y_log_value_t o11y_log_val_empty(void) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_EMPTY;
    v.value.int_val = 0;
    return v;
}

static inline o11y_log_value_t o11y_log_val_str(const char *s) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_STRING;
    v.value.str_val.data = s;
    v.value.str_val.len = 0;
    v.value.str_val.has_len = false;
    return v;
}

static inline o11y_log_value_t o11y_log_val_strn(const char *s, size_t len) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_STRING;
    v.value.str_val.data = s;
    v.value.str_val.len = len;
    v.value.str_val.has_len = true;
    return v;
}

static inline o11y_log_value_t o11y_log_val_bool(bool b) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_BOOL;
    v.value.bool_val = b;
    return v;
}

static inline o11y_log_value_t o11y_log_val_int(int64_t n) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_INT;
    v.value.int_val = n;
    return v;
}

static inline o11y_log_value_t o11y_log_val_double(double d) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_DOUBLE;
    v.value.double_val = d;
    return v;
}

static inline o11y_log_value_t o11y_log_val_bytes(const uint8_t *data, size_t len) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_BYTES;
    v.value.bytes_val.data = data;
    v.value.bytes_val.len = len;
    return v;
}

static inline o11y_log_value_t o11y_log_val_array(const o11y_log_value_t *items, size_t len) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_ARRAY;
    v.value.array_val.items = items;
    v.value.array_val.len = len;
    return v;
}

static inline o11y_log_value_t o11y_log_val_map(const o11y_log_attr_t *items, size_t len) {
    o11y_log_value_t v;
    v.kind = O11Y_LOG_VAL_MAP;
    v.value.map_val.items = items;
    v.value.map_val.len = len;
    return v;
}

static inline o11y_log_attr_t o11y_log_kv_str(const char *key, const char *val) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_str(val);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_bool(const char *key, bool val) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_bool(val);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_int(const char *key, int64_t val) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_int(val);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_double(const char *key, double val) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_double(val);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_bytes(const char *key, const uint8_t *data, size_t len) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_bytes(data, len);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_array(const char *key, const o11y_log_value_t *items, size_t len) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_array(items, len);
    return a;
}

static inline o11y_log_attr_t o11y_log_kv_map(const char *key, const o11y_log_attr_t *items, size_t len) {
    o11y_log_attr_t a;
    a.key = key;
    a.value = o11y_log_val_map(items, len);
    return a;
}

/* =========================================================================
 * Capture-time redaction helpers
 * ========================================================================= */

/** Returns the literal "REDACTED" for capture-time secret protection. */
const char *o11y_redact_secret(void);

/**
 * Masks value into out as a run of 'X' matching the UTF-8 code point count of
 * value. Writes a NUL terminator if out_cap > 0. Returns the full un-truncated
 * rune count (excluding NUL).
 */
size_t o11y_redact_mask(const char *value, size_t value_len, char *out, size_t out_cap);

/** Convenience log attribute carrying the capture-time literal "REDACTED". */
static inline o11y_log_attr_t o11y_log_kv_secret(const char *key) {
    return o11y_log_kv_str(key, "REDACTED");
}

/* =========================================================================
 * Configuration & lifecycle
 * ========================================================================= */

typedef enum o11y_env_mode {
    /** Read standard OTEL_* variables from the process environment (default). */
    O11Y_ENV_PROCESS = 0,
    /** Hermetic mode: ignore all OTEL_* variables; disable un-injected signals. */
    O11Y_ENV_HERMETIC = 1,
    /** Read variables from options.env_pairs. */
    O11Y_ENV_PAIRS = 2,
    /** Read "KEY=VALUE" entries from options.env_entries. */
    O11Y_ENV_ENTRIES = 3
} o11y_env_mode_t;

typedef struct o11y_env_pair {
    const char *key;
    const char *value;
} o11y_env_pair_t;

typedef enum o11y_protocol {
    /** Use OTEL_EXPORTER_OTLP_*_PROTOCOL or default http/protobuf. */
    O11Y_PROTOCOL_DEFAULT = 0,
    O11Y_PROTOCOL_HTTP_PROTOBUF = 1,
    O11Y_PROTOCOL_HTTP_JSON = 2,
    O11Y_PROTOCOL_GRPC = 3
} o11y_protocol_t;

typedef enum o11y_level {
    O11Y_LEVEL_DEBUG = 0,
    O11Y_LEVEL_INFO = 1,
    O11Y_LEVEL_WARN = 2,
    O11Y_LEVEL_ERROR = 3
} o11y_level_t;

typedef enum o11y_console_format {
    O11Y_CONSOLE_JSON = 0,
    O11Y_CONSOLE_TEXT = 1
} o11y_console_format_t;

typedef enum o11y_console_target {
    O11Y_CONSOLE_STDOUT = 0,
    O11Y_CONSOLE_STDERR = 1,
    O11Y_CONSOLE_CUSTOM = 2
} o11y_console_target_t;

/** Custom console write callback. Return O11Y_OK on success or error to reject. */
typedef o11y_err_t (*o11y_console_write_fn)(void *userdata, const uint8_t *bytes, size_t len);

typedef enum o11y_pii_mode {
    O11Y_PII_DROP = 0,
    O11Y_PII_HASH = 1,
    O11Y_PII_ALLOW = 2
} o11y_pii_mode_t;

typedef enum o11y_sampler_kind {
    /** Use OTEL_TRACES_SAMPLER or default ParentBased(AlwaysOn). */
    O11Y_SAMPLER_DEFAULT = 0,
    O11Y_SAMPLER_ALWAYS_ON = 1,
    O11Y_SAMPLER_ALWAYS_OFF = 2,
    O11Y_SAMPLER_TRACE_ID_RATIO = 3,
    O11Y_SAMPLER_PARENT_BASED_ALWAYS_ON = 4,
    O11Y_SAMPLER_PARENT_BASED_ALWAYS_OFF = 5,
    O11Y_SAMPLER_PARENT_BASED_TRACE_ID_RATIO = 6
} o11y_sampler_kind_t;

typedef enum o11y_exemplar_filter {
    /** Use OTEL_METRICS_EXEMPLAR_FILTER or default trace_based. */
    O11Y_EXEMPLAR_FILTER_DEFAULT = 0,
    O11Y_EXEMPLAR_FILTER_TRACE_BASED = 1,
    O11Y_EXEMPLAR_FILTER_ALWAYS_ON = 2,
    O11Y_EXEMPLAR_FILTER_ALWAYS_OFF = 3
} o11y_exemplar_filter_t;

typedef struct o11y_build_info {
    bool enabled;
    const char *version;
    const char *revision;
    const char *time;
    bool modified_set;
    bool modified;
} o11y_build_info_t;

typedef struct o11y_app_registry_source {
    /** If content != NULL, validates YAML in memory; otherwise reads file_path. */
    const char *file_path;
    const char *content;
    size_t content_len;
} o11y_app_registry_source_t;

typedef struct o11y_histogram_buckets {
    const char *instrument_name;
    const double *boundaries;
    size_t boundaries_len;
} o11y_histogram_buckets_t;

/**
 * Attribute replacer callback invoked once per leaf log attribute before
 * per-leg sensitivity classification.
 *
 * To drop the attribute, return false.
 * To keep unchanged, leave out_key_buf[0] == '\0' and return true.
 * To rename the key (or replace a string value), write NUL-terminated text into
 * out_key_buf / out_str_val_buf and set *out_replace_str_val = true if replacing value.
 */
typedef bool (*o11y_attr_replacer_fn)(
    void *userdata,
    const char *const *groups,
    size_t groups_len,
    const char *key,
    const o11y_log_value_t *value,
    char *out_key_buf,
    size_t out_key_cap,
    char *out_str_val_buf,
    size_t out_str_val_cap,
    bool *out_replace_str_val);

/** Extra log sink callbacks (post-classification, correlated). */
typedef struct o11y_log_sink {
    void *userdata;
    bool (*enabled)(void *userdata, o11y_level_t level, bool force_emit);
    o11y_err_t (*emit)(
        void *userdata,
        uint64_t time_unix_nano,
        o11y_level_t level,
        const char *message,
        o11y_span_context_t span_context,
        const o11y_log_attr_t *attrs,
        size_t attrs_len);
} o11y_log_sink_t;

typedef bool (*o11y_baggage_egress_allow_fn)(const char *key, size_t key_len);
typedef void (*o11y_error_handler_fn)(void *userdata, const char *message);

typedef struct o11y_options {
    o11y_env_mode_t env_mode;
    const o11y_env_pair_t *env_pairs;
    size_t env_pairs_len;
    const char *const *env_entries;
    size_t env_entries_len;

    o11y_protocol_t protocol;

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
    o11y_console_target_t console_target;
    o11y_console_write_fn console_write_fn;
    void *console_write_userdata;
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
    bool startup_summary;

    o11y_error_handler_fn error_handler_fn;
    void *error_handler_userdata;
} o11y_options_t;

/** Returns an options struct populated with libo11y defaults. */
o11y_options_t o11y_options_default(void);

typedef struct o11y_shutdown_report {
    o11y_err_t logs;
    o11y_err_t metrics;
    o11y_err_t traces;
} o11y_shutdown_report_t;

static inline bool o11y_shutdown_report_ok(o11y_shutdown_report_t r) {
    return r.logs == O11Y_OK && r.metrics == O11Y_OK && r.traces == O11Y_OK;
}

/**
 * Builds an SDK, emits the o11y.telemetry.configured startup canary, and
 * acquires the process-global double-setup guard.
 *
 * Fails with O11Y_ERR_ALREADY_SETUP if another setup instance is active.
 * Never aborts or exits the process.
 */
o11y_err_t o11y_setup(
    const o11y_options_t *options,
    o11y_sdk_t **out_sdk,
    o11y_diagnostic_t *diag);

/**
 * Builds an independent SDK without touching process globals or emitting the
 * startup canary. Safe for parallel tests and multiple instances.
 */
o11y_err_t o11y_init(
    const o11y_options_t *options,
    o11y_sdk_t **out_sdk,
    o11y_diagnostic_t *diag);

/**
 * Shuts down logs, metrics, and traces concurrently under one shared timeout
 * (0 uses the 5000 ms default). Idempotent: concurrent and later callers wait
 * and receive the same per-signal report.
 */
o11y_err_t o11y_shutdown(
    o11y_sdk_t *sdk,
    uint64_t timeout_ms,
    o11y_shutdown_report_t *out_report);

/** Flushes all three signals under one shared timeout (0 = 5000 ms default). */
o11y_err_t o11y_force_flush(
    o11y_sdk_t *sdk,
    uint64_t timeout_ms,
    o11y_shutdown_report_t *out_report);

/** Shuts down if not already shut down and frees all SDK memory (NULL-safe). */
void o11y_destroy(o11y_sdk_t *sdk);

/** Returns the single-line effective configuration summary (valid for SDK lifetime). */
const char *o11y_effective_config(const o11y_sdk_t *sdk);

/** Signal-driven graceful shutdown options. */
typedef struct o11y_signal_options {
    /** Total shared budget in milliseconds (0 = 5000 ms default). */
    uint64_t timeout_ms;
    /** Optional hook invoked after signal receipt and before telemetry shutdown. */
    void (*before_shutdown)(void *userdata);
    void *before_shutdown_userdata;
    /** POSIX signal numbers (NULL/0 defaults to SIGINT and SIGTERM). */
    const int *signals;
    size_t signals_len;
} o11y_signal_options_t;

/**
 * Installs signal handlers, blocks until a signal arrives, restores SIG_DFL,
 * invokes before_shutdown, and shuts down sdk under one shared deadline.
 */
o11y_err_t o11y_shutdown_on_signals(
    o11y_sdk_t *sdk,
    const o11y_signal_options_t *options,
    o11y_shutdown_report_t *out_report);

/* =========================================================================
 * Context
 * ========================================================================= */

/** Creates a new empty context (NULL is also accepted anywhere as background). */
o11y_ctx_t *o11y_ctx_create(void);
void o11y_ctx_destroy(o11y_ctx_t *ctx);

/** Derives a new context carrying span (caller must destroy returned context). */
o11y_ctx_t *o11y_ctx_with_span(const o11y_ctx_t *parent, o11y_span_t *span);
/** Derives a new context carrying a remote span context. */
o11y_ctx_t *o11y_ctx_with_span_context(const o11y_ctx_t *parent, o11y_span_context_t sc);
/** Derives a new context whose log records bypass level gates. */
o11y_ctx_t *o11y_ctx_with_force_emit(const o11y_ctx_t *parent);
/** Derives a new context carrying wide-event accumulator record. */
o11y_ctx_t *o11y_ctx_with_record(const o11y_ctx_t *parent, o11y_record_t *record);
/** Derives a new context with a baggage key/value added or replaced. */
o11y_ctx_t *o11y_ctx_with_baggage_item(const o11y_ctx_t *parent, const char *key, const char *value);

/** Reads the active span context from ctx (invalid when none). */
o11y_span_context_t o11y_ctx_span_context(const o11y_ctx_t *ctx);
/** Reads a baggage value by key from ctx, or NULL if absent (valid for ctx lifetime). */
const char *o11y_ctx_baggage_get(const o11y_ctx_t *ctx, const char *key);
/** Returns the wide-event record attached to ctx, or NULL. */
o11y_record_t *o11y_ctx_record(const o11y_ctx_t *ctx);

/* =========================================================================
 * Tracing
 * ========================================================================= */

typedef enum o11y_span_kind {
    O11Y_SPAN_KIND_INTERNAL = 1,
    O11Y_SPAN_KIND_SERVER = 2,
    O11Y_SPAN_KIND_CLIENT = 3,
    O11Y_SPAN_KIND_PRODUCER = 4,
    O11Y_SPAN_KIND_CONSUMER = 5
} o11y_span_kind_t;

typedef enum o11y_status_code {
    O11Y_STATUS_UNSET = 0,
    O11Y_STATUS_ERROR = 1,
    O11Y_STATUS_OK = 2
} o11y_status_code_t;

typedef struct o11y_span_link {
    o11y_span_context_t span_context;
    const o11y_attr_t *attributes;
    size_t attributes_len;
} o11y_span_link_t;

typedef struct o11y_span_start_options {
    o11y_span_kind_t kind; /* 0 defaults to O11Y_SPAN_KIND_INTERNAL */
    const o11y_attr_t *attributes;
    size_t attributes_len;
    const o11y_span_link_t *links;
    size_t links_len;
    /** Unix nanoseconds; 0 uses current wall clock time. */
    uint64_t start_time_unix_nano;
    /** Ignore parent span in ctx and start a new root trace. */
    bool new_root;
} o11y_span_start_options_t;

/** Returns a tracer scoped to name (valid for the lifetime of sdk). */
o11y_tracer_t *o11y_tracer(o11y_sdk_t *sdk, const char *name);
o11y_tracer_t *o11y_tracer_with_scope(
    o11y_sdk_t *sdk,
    const char *name,
    const char *version,
    const char *schema_url);

/** Starts a span. Call o11y_span_end() to end and release the handle. */
o11y_span_t *o11y_tracer_start(
    o11y_tracer_t *tracer,
    const o11y_ctx_t *ctx,
    const char *name,
    const o11y_span_start_options_t *options);

o11y_span_context_t o11y_span_context(const o11y_span_t *span);
bool o11y_span_is_recording(const o11y_span_t *span);
void o11y_span_set_name(o11y_span_t *span, const char *name);
void o11y_span_set_attrs(o11y_span_t *span, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_span_set_attr(o11y_span_t *span, o11y_attr_t attr);
void o11y_span_set_status(o11y_span_t *span, o11y_status_code_t code, const char *description);
void o11y_span_add_event(
    o11y_span_t *span,
    const char *name,
    const o11y_attr_t *attrs,
    size_t attrs_len,
    uint64_t timestamp_unix_nano);
void o11y_span_record_error(
    o11y_span_t *span,
    const char *error_type,
    const char *message,
    const o11y_attr_t *attrs,
    size_t attrs_len);
void o11y_span_add_link(o11y_span_t *span, const o11y_span_link_t *link);

/** Ends the span and frees the handle (NULL-safe). */
void o11y_span_end(o11y_span_t *span);
/** Ends the span with an explicit Unix nanosecond timestamp and frees the handle. */
void o11y_span_end_at(o11y_span_t *span, uint64_t end_time_unix_nano);

/* =========================================================================
 * Metrics & Exemplars
 * ========================================================================= */

typedef struct o11y_instrument_options {
    const char *description;
    const char *unit;
} o11y_instrument_options_t;

typedef struct o11y_histogram_options {
    const char *description;
    const char *unit;
    const double *explicit_bucket_boundaries;
    size_t explicit_bucket_boundaries_len;
} o11y_histogram_options_t;

typedef struct o11y_counter_i64 { void *impl; } o11y_counter_i64_t;
typedef struct o11y_counter_f64 { void *impl; } o11y_counter_f64_t;
typedef struct o11y_updown_i64 { void *impl; } o11y_updown_i64_t;
typedef struct o11y_updown_f64 { void *impl; } o11y_updown_f64_t;
typedef struct o11y_histogram_i64 { void *impl; } o11y_histogram_i64_t;
typedef struct o11y_histogram_f64 { void *impl; } o11y_histogram_f64_t;
typedef struct o11y_gauge_i64 { void *impl; } o11y_gauge_i64_t;
typedef struct o11y_gauge_f64 { void *impl; } o11y_gauge_f64_t;

typedef struct o11y_observation_i64 o11y_observation_i64_t;
typedef struct o11y_observation_f64 o11y_observation_f64_t;

typedef void (*o11y_observe_i64_fn)(void *userdata, o11y_observation_i64_t *obs);
typedef void (*o11y_observe_f64_fn)(void *userdata, o11y_observation_f64_t *obs);

void o11y_observation_i64_observe(
    o11y_observation_i64_t *obs,
    int64_t value,
    const o11y_attr_t *attrs,
    size_t attrs_len);

void o11y_observation_f64_observe(
    o11y_observation_f64_t *obs,
    double value,
    const o11y_attr_t *attrs,
    size_t attrs_len);

/** Returns a meter scoped to name (valid for the lifetime of sdk). */
o11y_meter_t *o11y_meter(o11y_sdk_t *sdk, const char *name);
o11y_meter_t *o11y_meter_with_scope(
    o11y_sdk_t *sdk,
    const char *name,
    const char *version,
    const char *schema_url);

o11y_counter_i64_t o11y_meter_counter_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_counter_f64_t o11y_meter_counter_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_updown_i64_t o11y_meter_updown_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_updown_f64_t o11y_meter_updown_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_histogram_i64_t o11y_meter_histogram_i64(o11y_meter_t *meter, const char *name, const o11y_histogram_options_t *opts);
o11y_histogram_f64_t o11y_meter_histogram_f64(o11y_meter_t *meter, const char *name, const o11y_histogram_options_t *opts);
o11y_gauge_i64_t o11y_meter_gauge_i64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);
o11y_gauge_f64_t o11y_meter_gauge_f64(o11y_meter_t *meter, const char *name, const o11y_instrument_options_t *opts);

void o11y_counter_i64_add(o11y_counter_i64_t inst, const o11y_ctx_t *ctx, int64_t value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_counter_f64_add(o11y_counter_f64_t inst, const o11y_ctx_t *ctx, double value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_updown_i64_add(o11y_updown_i64_t inst, const o11y_ctx_t *ctx, int64_t value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_updown_f64_add(o11y_updown_f64_t inst, const o11y_ctx_t *ctx, double value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_histogram_i64_record(o11y_histogram_i64_t inst, const o11y_ctx_t *ctx, int64_t value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_histogram_f64_record(o11y_histogram_f64_t inst, const o11y_ctx_t *ctx, double value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_gauge_i64_record(o11y_gauge_i64_t inst, const o11y_ctx_t *ctx, int64_t value, const o11y_attr_t *attrs, size_t attrs_len);
void o11y_gauge_f64_record(o11y_gauge_f64_t inst, const o11y_ctx_t *ctx, double value, const o11y_attr_t *attrs, size_t attrs_len);

/** Registers an observable instrument with an observation callback. */
o11y_err_t o11y_meter_observable_counter_i64(
    o11y_meter_t *meter,
    const char *name,
    const o11y_instrument_options_t *opts,
    o11y_observe_i64_fn callback,
    void *userdata);

o11y_err_t o11y_meter_observable_gauge_f64(
    o11y_meter_t *meter,
    const char *name,
    const o11y_instrument_options_t *opts,
    o11y_observe_f64_fn callback,
    void *userdata);

/* =========================================================================
 * Structured logging, Events, and Wide Events (Record)
 * ========================================================================= */

void o11y_log(
    o11y_sdk_t *sdk,
    o11y_level_t level,
    const o11y_ctx_t *ctx,
    const char *message,
    const o11y_log_attr_t *attrs,
    size_t attrs_len);

static inline void o11y_log_debug(o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const char *msg, const o11y_log_attr_t *attrs, size_t n) {
    o11y_log(sdk, O11Y_LEVEL_DEBUG, ctx, msg, attrs, n);
}
static inline void o11y_log_info(o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const char *msg, const o11y_log_attr_t *attrs, size_t n) {
    o11y_log(sdk, O11Y_LEVEL_INFO, ctx, msg, attrs, n);
}
static inline void o11y_log_warn(o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const char *msg, const o11y_log_attr_t *attrs, size_t n) {
    o11y_log(sdk, O11Y_LEVEL_WARN, ctx, msg, attrs, n);
}
static inline void o11y_log_error(o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const char *msg, const o11y_log_attr_t *attrs, size_t n) {
    o11y_log(sdk, O11Y_LEVEL_ERROR, ctx, msg, attrs, n);
}

/**
 * Emits a contract-bearing event (exempt from level gates, carries event.name,
 * validated against spec event contracts). Never fails the host.
 */
void o11y_event(
    o11y_sdk_t *sdk,
    const o11y_ctx_t *ctx,
    const char *event_name,
    const o11y_log_attr_t *attrs,
    size_t attrs_len);

/** Wide-event accumulator (thread-safe; all methods are NULL-safe no-ops). */
o11y_record_t *o11y_record_create(void);
void o11y_record_destroy(o11y_record_t *rec);
void o11y_record_set(o11y_record_t *rec, o11y_log_attr_t attr);
void o11y_record_set_attrs(o11y_record_t *rec, const o11y_log_attr_t *attrs, size_t attrs_len);
void o11y_record_add(o11y_record_t *rec, const char *key, int64_t delta);
void o11y_record_max(o11y_record_t *rec, const char *key, double value);
void o11y_record_set_error(o11y_record_t *rec, const char *error_type);
void o11y_record_emit_event(
    o11y_record_t *rec,
    const o11y_ctx_t *ctx,
    o11y_sdk_t *sdk,
    const char *event_name,
    const o11y_log_attr_t *extra_attrs,
    size_t extra_attrs_len);

/* =========================================================================
 * W3C Context Propagation, Detached Work, and Child Process / Framed Sockets
 * ========================================================================= */

typedef struct o11y_carrier {
    void *userdata;
    /** Return NUL-terminated value for key, or NULL when absent. */
    const char *(*get)(void *userdata, const char *key);
    /** Store key/value (copied by callee if kept past return). */
    void (*set)(void *userdata, const char *key, const char *value);
} o11y_carrier_t;

void o11y_inject(const o11y_sdk_t *sdk, const o11y_ctx_t *ctx, const o11y_carrier_t *carrier);
o11y_ctx_t *o11y_extract(const o11y_sdk_t *sdk, const o11y_ctx_t *parent, const o11y_carrier_t *carrier);

/** Detached work propagation (URL-query-encoded carrier, <= 32 KiB). */
o11y_err_t o11y_detached_capture(
    const o11y_sdk_t *sdk,
    const o11y_ctx_t *ctx,
    o11y_detached_carrier_t **out_carrier);
bool o11y_detached_is_zero(const o11y_detached_carrier_t *carrier);
o11y_span_context_t o11y_detached_span_context(const o11y_detached_carrier_t *carrier);
o11y_err_t o11y_detached_marshal(const o11y_detached_carrier_t *carrier, char **out_text);
o11y_err_t o11y_detached_unmarshal(const char *text, size_t text_len, o11y_detached_carrier_t **out_carrier);
void o11y_detached_destroy(o11y_detached_carrier_t *carrier);

o11y_linked_span_t *o11y_detached_start_linked(
    o11y_sdk_t *sdk,
    const o11y_ctx_t *ctx,
    const o11y_detached_carrier_t *carrier,
    const char *name,
    const o11y_span_start_options_t *options);
const o11y_ctx_t *o11y_linked_span_ctx(const o11y_linked_span_t *linked);
o11y_span_t *o11y_linked_span_handle(o11y_linked_span_t *linked);
void o11y_linked_span_end(o11y_linked_span_t *linked);

/** Child-process environment propagation (TRACEPARENT / TRACESTATE, no baggage). */
bool o11y_proc_env_entries(
    const o11y_ctx_t *ctx,
    char **out_traceparent_entry,
    char **out_tracestate_entry);
o11y_ctx_t *o11y_proc_extract_env(
    const o11y_ctx_t *parent,
    const char *traceparent,
    const char *tracestate);

/* =========================================================================
 * Specification, sensitivity, and conformance utilities
 * ========================================================================= */

o11y_sensitivity_t o11y_spec_sensitivity_of(const char *key);
o11y_cardinality_t o11y_spec_cardinality_of(const char *key);

/**
 * Derives service.instance.id from Kubernetes pod identity (UUIDv5).
 * Returns true and writes 36-char UUID + NUL to out when pod identity exists,
 * or false when neither pod_uid nor pod_name is non-empty.
 */
bool o11y_derive_instance_id(
    const char *pod_uid,
    const char *pod_name,
    const char *namespace_name,
    char out[37]);

/** Sanitizes an OTLP endpoint URL (strips userinfo/query/fragment; "unparseable" on ambiguity). */
o11y_err_t o11y_sanitize_endpoint(const char *raw, size_t raw_len, char **out);

/** Computes Go-exact PII canonical rendering and hmac-sha256:<32hex> token. */
o11y_err_t o11y_pii_hash_value(
    const o11y_log_value_t *value,
    const uint8_t *key,
    size_t key_len,
    char **out_canonical,
    char out_token[45]);

/**
 * Validates an application attribute registry YAML buffer and renders the
 * conformance .want outcome ("ok N ns", violations, or "parse: <kind>").
 * out_status receives 0 (valid), 1 (policy violations), or 2 (parse error).
 */
o11y_err_t o11y_app_registry_check_bytes(
    const char *content,
    size_t content_len,
    char **out_want,
    int *out_status);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* O11Y_H */
